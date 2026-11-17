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

/*
 * 最小 DOM 替身：只提供 controller 就地更新进度时用到的三个选择器与
 * setText / setAttribute / style。用于证明进度更新不会触发整页渲染。
 */
function makeProgressDom() {
	const text = {
		value: '',
		setText(next) {
			this.value = next;
		},
	};
	const fill = { style: {} };
	const wrapper = {
		attrs: {},
		setAttribute(name, value) {
			this.attrs[name] = value;
		},
	};
	return {
		text,
		fill,
		wrapper,
		querySelector(selector) {
			if (selector === '.orphan-cleanup-convert-progress') return wrapper;
			if (selector === '.orphan-cleanup-convert-progress-text') return text;
			if (selector === '.orphan-cleanup-convert-progress-fill') return fill;
			return null;
		},
	};
}

function makeHost(files, contentEl, onRender) {
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
		contentEl,
		candidates: { convertibleImages: files },
		conversion: state,
		conversionConfig: () => ({ ...config }),
		imageCodec: () => {
			throw new Error('估算不应调用 codec');
		},
		activeTab: 'image-convert',
		estimateController: undefined,
		renderContents() {
			onRender();
		},
	};
}

test('估算进度就地更新，不重建整页', async () => {
	const files = [makeFile('a.png', 100), makeFile('b.png', 200), makeFile('c.png', 300)];
	const dom = makeProgressDom();
	let renders = 0;
	const host = makeHost(files, dom, () => {
		renders += 1;
	});

	await estimateConversions(host);

	assert.equal(renders, 2, '开始与结束各渲染一次，进度更新不应整页重建');
	assert.match(dom.text.value, /^正在估算 3 \/ 3/);
	assert.equal(dom.fill.style.width, '100%');
	assert.equal(dom.wrapper.attrs['data-phase'], 'estimate');
});

test('缺少进度节点时整页渲染最多回退一次', async () => {
	const files = [makeFile('a.png', 100), makeFile('b.png', 200)];
	let renders = 0;
	const host = makeHost(files, undefined, () => {
		renders += 1;
	});

	await estimateConversions(host);

	// 开始 1 次 + 进度回退 1 次 + 结束 1 次；不会每个进度事件都重渲染。
	assert.equal(renders, 3);
});
