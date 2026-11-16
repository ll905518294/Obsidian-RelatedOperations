import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const obsidianStub = `
export class TAbstractFile {}
export class TFile {}
export class TFolder {}
export class App {}
export class FileSystemAdapter {}
export class Notice { constructor(message) { globalThis.__notices.push(String(message)); } }
export const Platform = {};
`;

const bundle = await build({
	stdin: {
		contents: `
			export { createConversionState, estimateConversions } from './src/cleanup/cleanup-conversion-controller.ts';
		`,
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'node',
	plugins: [
		{
			name: 'obsidian-stub',
			setup(b) {
				b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'obsidian-stub' }));
				b.onLoad({ filter: /.*/, namespace: 'obsidian-stub' }, () => ({ contents: obsidianStub, loader: 'js' }));
			},
		},
		{
			name: 'cleanup-list-stub',
			setup(b) {
				b.onResolve({ filter: /cleanup-list-convert(\.ts)?$/ }, () => ({ path: 'cleanup-list-convert', namespace: 'list-stub' }));
				b.onLoad({ filter: /.*/, namespace: 'list-stub' }, () => ({ contents: 'export function clearConversionSelections() {}', loader: 'js' }));
			},
		},
	],
});

const { createConversionState, estimateConversions } = await import(
	`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

globalThis.__notices = [];

const config = { sources: ['png'], target: 'jpg', quality: 85, alpha: 'flatten' };

function makeFile(path, size = 100) {
	return {
		path,
		name: path.slice(path.lastIndexOf('/') + 1),
		extension: path.slice(path.lastIndexOf('.') + 1),
		stat: { size, mtime: 1 },
	};
}

function makeHost(files, codec) {
	const state = createConversionState(config);
	state.abort = () => {};
	return {
		app: {
			vault: {
				getFiles: () => files,
				getAbstractFileByPath: (path) => files.find((file) => file.path === path) ?? null,
				readBinary: async () => new ArrayBuffer(8),
				cachedRead: async () => '',
				read: async () => '',
			},
			metadataCache: { resolvedLinks: {}, getFileCache: () => null, getFirstLinkpathDest: () => null },
		},
		candidates: { convertibleImages: files },
		conversion: state,
		conversionConfig: () => ({ ...config }),
		imageCodec: () => codec,
		activeTab: 'image-convert',
		estimateController: undefined,
		renderContents() {},
	};
}

test('重复点击估算会复用上次结果，不再完整解码', async () => {
	const files = [makeFile('a.png', 100), makeFile('b.png', 200)];
	let decodes = 0;
	const codec = {
		decode: async () => {
			decodes += 1;
			return { ok: true, image: { width: 1200, height: 800, hasAlpha: false, source: {} } };
		},
		encode: async () => ({ ok: true, bytes: new ArrayBuffer(400) }),
		release: () => {},
	};
	const host = makeHost(files, codec);

	await estimateConversions(host);
	assert.equal(host.conversion.items.length, 2);
	assert.equal(decodes, 2);

	await estimateConversions(host);
	assert.equal(decodes, 2, '第二次点击不应重复解码');
	assert.equal(host.conversion.items.length, 2);
});

test('源文件变化后再次估算只重算变化的文件', async () => {
	const files = [makeFile('a.png', 100), makeFile('b.png', 200)];
	let decodes = 0;
	const codec = {
		decode: async () => {
			decodes += 1;
			return { ok: true, image: { width: 1200, height: 800, hasAlpha: false, source: {} } };
		},
		encode: async () => ({ ok: true, bytes: new ArrayBuffer(400) }),
		release: () => {},
	};
	const host = makeHost(files, codec);

	await estimateConversions(host);
	files[0].stat.mtime = 2;
	await estimateConversions(host);

	assert.equal(decodes, 3, '只应重新解码 a.png');
	assert.equal(host.conversion.items.find((item) => item.path === 'a.png').sourceMtime, 2);
});
