import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const obsidianStub = `
export class App {}
export class FileSystemAdapter {}
export class TAbstractFile {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class Notice { constructor(message) { globalThis.__notices.push(String(message)); } }
export const Platform = {};
`;

const scanStub = `
export function collectConvertibleImages() { return []; }
export async function estimateConversions(app, files, config, onProgress, signal) {
	globalThis.__estimateSignal = signal;
	if (globalThis.__estimateGate) await globalThis.__estimateGate;
	return globalThis.__estimateItems ?? [];
}
`;

const listStub = `
export function clearConversionSelections() {}
`;

const runnerStub = `
export async function runImageConversion(app, codec, batch, options) {
	globalThis.__runnerBatches.push(batch.map((item) => item.path));
	if (globalThis.__runnerGate) await globalThis.__runnerGate;
	return globalThis.__runnerResult ?? {
		converted: [], skipped: [], failed: [], pendingTrash: [], savedBytes: 0,
		aborted: Boolean(options?.signal?.aborted), unrestored: [],
	};
}
`;

const bundle = await build({
	stdin: {
		contents: `
			export { createConversionState, estimateConversions, convertSelected } from './src/cleanup/cleanup-conversion-controller.ts';
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
			name: 'scan-stub',
			setup(b) {
				b.onResolve({ filter: /^\.\/cleanup-scan$/ }, () => ({ path: 'cleanup-scan', namespace: 'scan-stub' }));
				b.onLoad({ filter: /.*/, namespace: 'scan-stub' }, () => ({ contents: scanStub, loader: 'js' }));
			},
		},
		{
			name: 'list-stub',
			setup(b) {
				b.onResolve({ filter: /^\.\/cleanup-list-convert$/ }, () => ({ path: 'cleanup-list-convert', namespace: 'list-stub' }));
				b.onLoad({ filter: /.*/, namespace: 'list-stub' }, () => ({ contents: listStub, loader: 'js' }));
			},
		},
		{
			name: 'runner-stub',
			setup(b) {
				b.onResolve({ filter: /^\.\.\/image-convert\/image-convert-runner$/ }, () => ({ path: 'image-convert-runner', namespace: 'runner-stub' }));
				b.onLoad({ filter: /.*/, namespace: 'runner-stub' }, () => ({ contents: runnerStub, loader: 'js' }));
			},
		},
	],
});

const { createConversionState, estimateConversions, convertSelected } = await import(
	`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

const config = { sources: ['png'], target: 'jpg', quality: 85, alpha: 'flatten' };

function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeFile(path) {
	return { path, extension: 'png', stat: { size: 100, mtime: 1 } };
}

function makeHost(files) {
	const state = createConversionState(config);
	state.items = [{ path: 'existing.png', extension: 'png', width: 1, height: 1, oldBytes: 100, newBytes: 80, hasAlpha: false, referenceCount: 0 }];
	return {
		app: {},
		settings: { orphanImageExtensions: 'png', orphanIgnoredFolders: '' },
		candidates: { convertibleImages: files },
		conversion: state,
		conversionConfig: () => ({ ...config }),
		imageCodec: () => ({}),
		activeTab: 'image-convert',
		convertSelections: new Set(files.map((file) => file.path)),
		estimateController: undefined,
		convertController: undefined,
		disposed: false,
		renderCount: 0,
		cacheSaves: 0,
		scannedTabs: [],
		renderContents() { this.renderCount += 1; },
		saveCacheToSettings() { this.cacheSaves += 1; },
		async scanTab(tab) { this.scannedTabs.push(tab); },
	};
}

test('中止估算会保留上一次完整结果并给出提示', async () => {
	globalThis.__notices = [];
	let release;
	globalThis.__estimateGate = new Promise((resolve) => { release = resolve; });
	globalThis.__estimateItems = [{ path: 'a.png', oldBytes: 100, newBytes: 50 }];
	const host = makeHost([makeFile('a.png')]);
	const previous = structuredClone(host.conversion.items);

	const run = estimateConversions(host);
	await tick();
	host.estimateController.abort();
	release();
	await run;
	globalThis.__estimateGate = undefined;

	assert.deepEqual(host.conversion.items, previous, '中止时不得用部分结果覆盖上一次估算');
	assert.equal(host.conversion.estimating, false);
	assert.ok(globalThis.__notices.some((message) => message.includes('已中止估算')));
});

test('转换期间关闭面板后不回写缓存、不刷新分类、不渲染', async () => {
	globalThis.__notices = [];
	globalThis.__runnerBatches = [];
	let release;
	globalThis.__runnerGate = new Promise((resolve) => { release = resolve; });
	globalThis.__runnerResult = {
		converted: [], skipped: [], failed: [], pendingTrash: [], savedBytes: 0, aborted: false, unrestored: [],
	};
	const host = makeHost([makeFile('a.png')]);

	const run = convertSelected(host);
	await tick();
	const rendersBeforeClose = host.renderCount;
	host.convertController.abort();
	host.disposed = true;
	release();
	await run;
	globalThis.__runnerGate = undefined;

	assert.equal(host.conversion.converting, false);
	assert.equal(host.cacheSaves, 0, '关闭后不得再写缓存');
	assert.deepEqual(host.scannedTabs, [], '关闭后不得再刷新分类');
	assert.equal(host.renderCount, rendersBeforeClose, '关闭后不得再渲染');
	assert.deepEqual(globalThis.__notices, [], '关闭后不再提示转换结果');
});
