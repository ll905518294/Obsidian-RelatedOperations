import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

/*
 * Guards for the "reclaim state after cleanup" feature.
 *
 * collectAutoEmptyFolders: folders that became empty after deleting files.
 * finalizeCleanup: trash those folders, count successes, rescan with fallback.
 * confirmCleanup: orchestration (auto-empty folders + notice copy).
 *
 * Source modules import `obsidian`, so we bundle with a stub, reusing the
 * existing esbuild-stub style from tests/cleanup-duplicate-flows.test.mjs.
 */

const obsidianStub = `
export class TAbstractFile { constructor(path = '') { this.path = path; } }
export class TFile extends TAbstractFile {
	constructor(path = '') {
		super(path);
		this.extension = path.split('.').pop() ?? '';
		this.name = path.slice(path.lastIndexOf('/') + 1);
		this.basename = this.name.includes('.') ? this.name.slice(0, this.name.lastIndexOf('.')) : this.name;
		this.stat = { size: 0, mtime: 0 };
	}
}
export class TFolder extends TAbstractFile {
	constructor(path = '', children = []) {
		super(path);
		this.children = children;
	}
}
export class App {}
export class FileSystemAdapter {}
export class Platform { static isMacOS = false; static isMobile = false; }
export class Notice { constructor(message) { (globalThis.__notices ??= []).push(String(message)); } }
export const setIcon = () => {};
export const normalizePath = (value) => value;
export class Modal { constructor() {} open() {} close() {} onOpen() {} onClose() {} }
export class Plugin {}
export const MarkdownView = class {};
`;

const modalStub = `
export class ConvertNativeLinksConfirmationModal { constructor() {} async waitForConfirmation() { return true; } }
export class ConvertWikiLinksConfirmationModal { constructor() {} async waitForConfirmation() { return true; } }
export class CreateNotesConfirmationModal { constructor() {} async waitForConfirmation() { return true; } }
export class RemoveBrokenLinksConfirmationModal { constructor() {} async waitForConfirmation() { return true; } }
export class ImagePreviewModal { constructor() {} open() {} }
`;

const bundle = await build({
	stdin: {
		contents: `
			export { collectAutoEmptyFolders, byPath, parentFolder } from './src/cleanup/cleanup-actions.ts';
			export { finalizeCleanup } from './src/cleanup/cleanup-finalize.ts';
			export { confirmCleanup } from './src/cleanup/cleanup-flows.ts';
			export { TFolder, TFile } from 'obsidian';
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
			name: 'cleanup-modals-stub',
			setup(b) {
				b.onResolve({ filter: /cleanup-modals(\.ts)?$/ }, () => ({ path: 'cleanup-modals', namespace: 'modal-stub' }));
				b.onLoad({ filter: /.*/, namespace: 'modal-stub' }, () => ({ contents: modalStub, loader: 'js' }));
			},
		},
	],
});

const source = bundle.outputFiles[0].text;
const { collectAutoEmptyFolders, finalizeCleanup, confirmCleanup, TFolder, TFile } = await import(
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

globalThis.__notices = [];
globalThis.window ??= {};

beforeEach(() => {
	globalThis.__notices = [];
});

function parentOf(path) {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

function makeWorld({ folderPaths = [], filePaths = [] } = {}) {
	const world = { folders: [], files: [] };
	for (const path of folderPaths) world.folders.push(new TFolder(path, []));
	for (const path of filePaths) {
		const node = new TFile(path);
		node.stat = { size: 1, mtime: 1 };
		world.files.push(node);
	}

	const getAbstractFileByPath = (path) => {
		if (!path) return null;
		const existing = [...world.folders, ...world.files].find((node) => node.path === path);
		if (!existing) return null;
		refreshChildren();
		return existing;
	};

	const refreshChildren = () => {
		for (const node of world.folders) {
			node.children = [
				...world.folders.filter((child) => parentOf(child.path) === node.path),
				...world.files.filter((child) => parentOf(child.path) === node.path),
			];
		}
	};

	const app = {
		vault: {
			getFiles: () => [...world.files],
			getMarkdownFiles: () => world.files.filter((node) => node.extension === 'md'),
			getAbstractFileByPath,
			cachedRead: async () => '',
			read: async () => '',
			readBinary: async () => new Uint8Array([0]).buffer,
		},
		metadataCache: { resolvedLinks: {}, getFileCache: () => null, getFirstLinkpathDest: () => null },
		fileManager: {
			trashFile: async (node) => {
				world.files = world.files.filter((item) => item !== node);
				world.folders = world.folders.filter((item) => item !== node);
			},
		},
	};
	return { world, app };
}

function hostFor(app, overrides = {}) {
	const trashed = [];
	const host = {
		app: {
			...app,
			fileManager: {
				trashFile: async (node) => {
					trashed.push(node.path);
					await app.fileManager.trashFile(node);
				},
			},
		},
		settings: { orphanImageExtensions: 'png', orphanIgnoredFolders: '' },
		candidates: { images: [], attachments: [], emptyFiles: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [], duplicates: [], duplicateWarnings: [] },
		selections: new Set(),
		duplicateSelections: new Set(),
		linkSelections: new Set(),
		noteLinkSelections: new Set(),
		activeTab: 'images',
		processed: undefined,
		async scanTab() {},
		async scan() {},
		saveCacheToSettings() {},
		renderContents() {},
		...overrides,
	};
	return { host, trashed };
}

// ---- A. collectAutoEmptyFolders ----

test('A: deleting the last file collects its folder', async () => {
	const { app } = makeWorld({ folderPaths: ['a'] });
	const result = await collectAutoEmptyFolders(app, ['a/x.md'], []);
	assert.deepEqual(result.map((node) => node.path), ['a']);
});

test('A: nested empty folders are all collected, children first', async () => {
	const { app } = makeWorld({ folderPaths: ['a', 'a/b', 'a/b/c'] });
	const result = await collectAutoEmptyFolders(app, ['a/b/c/x.md'], []);
	assert.deepEqual(result.map((node) => node.path), ['a/b/c', 'a/b', 'a']);
});

test('A: a folder that still holds another file is not collected', async () => {
	const { app } = makeWorld({ folderPaths: ['a'], filePaths: ['a/keep.md'] });
	const result = await collectAutoEmptyFolders(app, ['a/x.md'], []);
	assert.deepEqual(result, []);
});

test('A: a non-empty child folder blocks its parent', async () => {
	const { app } = makeWorld({ folderPaths: ['a', 'a/b'], filePaths: ['a/b/keep.md'] });
	const result = await collectAutoEmptyFolders(app, ['a/x.md'], []);
	assert.deepEqual(result, []);
});

test('A: hidden path segments are never collected', async () => {
	const { app } = makeWorld({ folderPaths: ['.trash', '.obsidian', '.git'] });
	const result = await collectAutoEmptyFolders(app, ['.trash/x.md', '.obsidian/x.md', '.git/x.md'], []);
	assert.deepEqual(result, []);
});

test('A: a hidden child folder keeps its parent from being treated as empty', async () => {
	const { app } = makeWorld({ folderPaths: ['a', 'a/.obsidian'] });
	const result = await collectAutoEmptyFolders(app, ['a/x.md'], []);
	assert.deepEqual(result, []);
});

test('A: ignored folders are never collected', async () => {
	const { app } = makeWorld({ folderPaths: ['archive', 'archive/sub'] });
	const result = await collectAutoEmptyFolders(app, ['archive/sub/x.md'], ['archive']);
	assert.deepEqual(result, []);
});

test('A: root folder is never collected', async () => {
	const { app } = makeWorld({ filePaths: [] });
	const result = await collectAutoEmptyFolders(app, ['x.md'], []);
	assert.deepEqual(result, []);
});

test('A: empty deletedPaths returns an empty list', async () => {
	const { app } = makeWorld({ folderPaths: ['a'] });
	const result = await collectAutoEmptyFolders(app, [], []);
	assert.deepEqual(result, []);
});

// ---- B. finalizeCleanup ----

test('B: finalizeCleanup trashes newly empty folders and counts them', async () => {
	const { app } = makeWorld({ folderPaths: ['a', 'a/b'] });
	const { host, trashed } = hostFor(app);
	const result = await finalizeCleanup(host, ['a/b/x.md']);
	assert.deepEqual(trashed, ['a/b', 'a']);
	assert.equal(result.removedFolders, 2);
});

test('B: a failing trashFile does not block the rest and is not counted', async () => {
	const { app } = makeWorld({ folderPaths: ['a', 'a/b'] });
	let calls = 0;
	const trashed = [];
	const { host } = hostFor(app, {
		app: {
			...app,
			fileManager: {
				trashFile: async (node) => {
					calls += 1;
					if (calls === 1) throw new Error('boom');
					trashed.push(node.path);
				},
			},
		},
	});
	const result = await finalizeCleanup(host, ['a/b/x.md']);
	assert.equal(result.removedFolders, 1, 'only the successful trash is counted');
	assert.deepEqual(trashed, ['a'], 'the remaining folder is still processed');
});

test('B: a host with scan + scanGeneration does a full rescan with preserveProcessed=true', async () => {
	const { app } = makeWorld({ folderPaths: ['a'] });
	const scanCalls = [];
	const scanTabCalls = [];
	let rendered = 0;
	const hostRef = {};
	const { host } = hostFor(app, {
		scanGeneration: 3,
		scan: async function scan(preserveProcessed) {
			scanCalls.push({ preserveProcessed, thisIsHost: this === hostRef.host });
		},
		scanTab: async (tab) => scanTabCalls.push(tab),
		renderContents: () => { rendered += 1; },
	});
	hostRef.host = host;
	await finalizeCleanup(host, ['a/x.md']);
	assert.deepEqual(scanCalls, [{ preserveProcessed: true, thisIsHost: true }]);
	assert.deepEqual(scanTabCalls, [], 'full rescan replaces the lightweight fallback');
	assert.equal(rendered, 0);
});

test('B: a host without scan falls back to scanTab("folders") + renderContents', async () => {
	const { app } = makeWorld({ folderPaths: ['a'] });
	const scanTabCalls = [];
	let rendered = 0;
	const { host } = hostFor(app, {
		scan: undefined,
		scanGeneration: undefined,
		scanTab: async (tab) => scanTabCalls.push(tab),
		renderContents: () => { rendered += 1; },
	});
	const result = await finalizeCleanup(host, ['a/x.md']);
	assert.equal(result.removedFolders, 1);
	assert.deepEqual(scanTabCalls, ['folders']);
	assert.equal(rendered, 1);
});

test('B: when the full rescan throws it falls back to the lightweight path', async () => {
	const { app } = makeWorld({ folderPaths: ['a'] });
	const scanTabCalls = [];
	let rendered = 0;
	const { host } = hostFor(app, {
		scanGeneration: 1,
		scan: async () => { throw new Error('scan boom'); },
		scanTab: async (tab) => scanTabCalls.push(tab),
		renderContents: () => { rendered += 1; },
	});
	const result = await finalizeCleanup(host, ['a/x.md']);
	assert.equal(result.removedFolders, 1, 'cleanup result must survive a failed rescan');
	assert.deepEqual(scanTabCalls, ['folders']);
	assert.equal(rendered, 1);
});

// ---- C. orchestration: confirmCleanup ----

test('C: confirmCleanup removes the emptied folder and reports it in the notice', async () => {
	const png = new TFile('orphan/a.png');
	png.stat = { size: 10, mtime: 1 };
	const fileList = [png];
	const folderList = [new TFolder('orphan', [])];
	const trashed = [];
	let scanTabCalls = 0;
	let scanCalls = 0;
	let saved = 0;

	const app = {
		vault: {
			getFiles: () => fileList,
			getMarkdownFiles: () => [],
			getRoot: () => {
				const root = new TFolder('', []);
				root.children = [...folderList.filter((node) => parentOf(node.path) === ''), ...fileList.filter((node) => parentOf(node.path) === '')];
				return root;
			},
			getAbstractFileByPath: (path) => {
				const match = [...fileList, ...folderList].find((node) => node.path === path);
				if (match instanceof TFolder) {
					match.children = fileList.filter((node) => parentOf(node.path) === match.path);
				}
				return match ?? null;
			},
			cachedRead: async () => '',
			read: async () => '',
			readBinary: async () => new Uint8Array([0]).buffer,
			process: async () => '',
		},
		metadataCache: { resolvedLinks: {}, getFileCache: () => null, getFirstLinkpathDest: () => null },
		fileManager: {
			trashFile: async (node) => {
				trashed.push(node.path);
				const index = fileList.indexOf(node);
				if (index >= 0) fileList.splice(index, 1);
				const folderIndex = folderList.indexOf(node);
				if (folderIndex >= 0) folderList.splice(folderIndex, 1);
			},
		},
	};

	const host = {
		app,
		settings: { orphanImageExtensions: 'png', orphanIgnoredFolders: '' },
		candidates: { images: [{ path: 'orphan/a.png' }], attachments: [], emptyFiles: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [], duplicates: [], duplicateWarnings: [] },
		selections: new Set(['orphan/a.png']),
		duplicateSelections: new Set(),
		linkSelections: new Set(),
		noteLinkSelections: new Set(),
		activeTab: 'images',
		scanGeneration: 1,
		async scan(preserveProcessed) {
			scanCalls += 1;
			assert.equal(preserveProcessed, true, 'rescan should preserve processed counts');
		},
		async scanTab() { scanTabCalls += 1; },
		saveCacheToSettings() { saved += 1; },
		renderContents() {},
	};

	await confirmCleanup(host);

	assert.deepEqual(trashed, ['orphan/a.png', 'orphan'], 'the file then its emptied folder');
	assert.equal(globalThis.__notices.length, 1);
	assert.match(globalThis.__notices[0], /自动清理了 1 个空文件夹/);
	assert.equal(scanCalls, 1, 'full rescan should run exactly once');
	assert.equal(scanTabCalls, 0, 'no lightweight fallback when the full rescan is available');
	assert.equal(saved, 1);
});
