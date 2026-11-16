import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const stub = `
export class TAbstractFile {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class App {}
export class FileSystemAdapter {}
export class Notice { constructor(message) { globalThis.__notices.push(String(message)); } }
export class Component { register() {} registerEvent() {} registerInterval() {} }
export class Modal extends Component {}
export class ItemView extends Component {}
export class PluginSettingTab extends Component {}
export class MarkdownView {}
export const setIcon = () => {};
export const normalizePath = p => p;
export const Platform = {};
`;

// 控制器只负责编排；扫描实现换成可控制的桩，便于观察调用次数与时机。
const scanStub = `
export async function findCleanupCandidates(app, imageExtensions, ignoredFolders, onProgress, checkLinksAndDuplicates, onCategoryComplete, signal) {
	globalThis.__scanCalls.push({ onProgress, onCategoryComplete, signal });
	if (globalThis.__scanGate) await globalThis.__scanGate;
	if (signal?.aborted) {
		const error = new Error('扫描已中止');
		error.name = 'CleanupScanAbortedError';
		throw error;
	}
	return { images: [], attachments: [], emptyFiles: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [], duplicates: [], duplicateWarnings: [], convertibleImages: [] };
}
export function collectCleanupFileSets() {
	return { extensions: new Set(), ignoredFolders: [], visibleFiles: [], images: [], attachments: [] };
}
export function collectConvertibleImages() { return []; }
export function findEmptyFiles() { return Promise.resolve([]); }
export function findRecursivelyEmptyFolders() { return []; }
export function markFilesReferencedByText() { return Promise.resolve(); }
`;

const bundle = await build({
	stdin: {
		contents: "export { runFullScan } from './src/cleanup/cleanup-scan-controller.ts';",
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
				b.onLoad({ filter: /.*/, namespace: 'obsidian-stub' }, () => ({ contents: stub }));
			},
		},
		{
			name: 'cleanup-scan-stub',
			setup(b) {
				b.onResolve({ filter: /^\.\/cleanup-scan$/ }, () => ({ path: 'cleanup-scan', namespace: 'scan-stub' }));
				b.onLoad({ filter: /.*/, namespace: 'scan-stub' }, () => ({ contents: scanStub }));
			},
		},
	],
});

const { runFullScan } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

globalThis.window ??= { setTimeout, clearTimeout };
globalThis.window.setInterval ??= () => 1;
globalThis.window.clearInterval ??= () => {};
globalThis.__notices = [];
globalThis.__scanCalls = [];

function makePanel() {
	return {
		app: {},
		settings: { orphanImageExtensions: 'png', orphanIgnoredFolders: '' },
		candidates: { images: [], attachments: [], emptyFiles: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [], duplicates: [], duplicateWarnings: [], convertibleImages: [] },
		conversion: {},
		activeTab: 'overview',
		scanning: false,
		hasScanned: false,
		scanGeneration: 0,
		scanStartedAt: 0,
		scanElapsedMs: 0,
		scanTimer: 0,
		scanStages: [],
		scanProgress: { stage: 0, processed: 0, total: 0 },
		scannedTabs: new Set(),
		scanningTabs: new Set(),
		dirtyTabs: new Set(),
		dirtyVersions: new Map(),
		categoryScans: new Map(),
		pages: new Map(),
		selections: new Set(),
		convertSelections: new Set(),
		linkSelections: new Set(),
		nativeSelections: new Set(),
		noteLinkSelections: new Set(),
		wikiSelections: new Set(),
		duplicateSelections: new Set(),
		renderContents() {},
		updateScanProgress() {},
		updateTabCounts() {},
		saveCacheToSettings() {},
		markTabDirty() {},
		async scanTab() {},
	};
}

function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

test('并发调用全量扫描会共享同一个任务，不会重复扫描', async () => {
	globalThis.__scanCalls.length = 0;
	let release;
	globalThis.__scanGate = new Promise((resolve) => { release = resolve; });
	const panel = makePanel();
	const first = runFullScan(panel);
	const second = runFullScan(panel);
	assert.equal(first, second, '并发调用应返回同一个 Promise');
	assert.equal(globalThis.__scanCalls.length, 1, '只允许启动一次真实扫描');
	assert.equal(panel.scanning, true);
	release();
	await first;
	globalThis.__scanGate = undefined;
	assert.equal(panel.scanning, false);
	assert.equal(panel.scannedTabs.size, 9);
	assert.equal(panel.hasScanned, true);
});

test('分类刷新进行中请求全量扫描时会排队等待，结束后再开始', async () => {
	globalThis.__scanCalls.length = 0;
	globalThis.__scanGate = undefined;
	const panel = makePanel();
	let finishCategory;
	panel.scanningTabs.add('images');
	panel.categoryScans.set('images', new Promise((resolve) => { finishCategory = resolve; }));

	const scan = runFullScan(panel);
	await tick();
	assert.equal(globalThis.__scanCalls.length, 0, '分类刷新结束前不得启动全量扫描');
	assert.equal(panel.scanning, false);

	finishCategory();
	panel.scanningTabs.delete('images');
	panel.categoryScans.delete('images');
	await scan;
	assert.equal(globalThis.__scanCalls.length, 1, '分类刷新结束后应执行排队的全量扫描');
	assert.equal(panel.scannedTabs.size, 9);
});

test('等待分类刷新期间关闭面板则不再启动全量扫描', async () => {
	globalThis.__scanCalls.length = 0;
	globalThis.__scanGate = undefined;
	const panel = makePanel();
	let finishCategory;
	panel.scanningTabs.add('images');
	panel.categoryScans.set('images', new Promise((resolve) => { finishCategory = resolve; }));

	const scan = runFullScan(panel);
	await tick();
	panel.scanGeneration++;
	finishCategory();
	await scan;

	assert.equal(globalThis.__scanCalls.length, 0);
	assert.equal(panel.scanning, false);
	assert.equal(panel.hasScanned, false);
});
