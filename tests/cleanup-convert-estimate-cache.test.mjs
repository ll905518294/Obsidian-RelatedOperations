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

function makeHost(files) {
	const state = createConversionState(config);
	state.abort = () => {};
	return {
		app: {
			vault: {
				getFiles: () => files,
				getAbstractFileByPath: (path) => files.find((file) => file.path === path) ?? null,
				readBinary: async () => {
					throw new Error('快速预估不应读取文件内容');
				},
				cachedRead: async () => {
					throw new Error('快速预估不应读取笔记正文');
				},
				read: async () => {
					throw new Error('快速预估不应读取笔记正文');
				},
			},
			metadataCache: { resolvedLinks: {}, getFileCache: () => null, getFirstLinkpathDest: () => null },
		},
		candidates: { convertibleImages: files },
		conversion: state,
		conversionConfig: () => ({ ...config }),
		// 控制器在估算路径上不再使用 codec；保留方法以兼容 host 契约。
		imageCodec: () => {
			throw new Error('快速预估不应调用 codec');
		},
		activeTab: 'image-convert',
		estimateController: undefined,
		renderContents() {},
	};
}

test('重复点击估算结果一致且始终不读取/解码文件', async () => {
	const files = [makeFile('a.png', 100), makeFile('b.png', 200)];
	const host = makeHost(files);

	await estimateConversions(host);
	assert.equal(host.conversion.items.length, 2);
	const first = structuredClone(host.conversion.items);

	await estimateConversions(host);
	assert.deepEqual(host.conversion.items, first, '同样输入下预估结果应稳定');
});

test('源文件体积变化后按新体积重新预估', async () => {
	const files = [makeFile('a.png', 100), makeFile('b.png', 200)];
	const host = makeHost(files);

	await estimateConversions(host);
	const before = host.conversion.items.find((item) => item.path === 'a.png').newBytes;
	files[0].stat.size = 1000;
	await estimateConversions(host);
	const after = host.conversion.items.find((item) => item.path === 'a.png').newBytes;

	assert.ok(after > before, `体积变大后预估应变大：${before} -> ${after}`);
});
