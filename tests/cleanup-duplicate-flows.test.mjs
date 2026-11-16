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
export const setIcon = () => {};
export const Platform = {};
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
			export { confirmCleanupDuplicates } from './src/cleanup/cleanup-flows.ts';
			export { planDuplicateDeletion } from './src/duplicate-files.ts';
			export { TFile } from 'obsidian';
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
const { confirmCleanupDuplicates, TFile } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

globalThis.__notices = [];

function makeFile(path, bytes) {
	const file = new TFile();
	file.path = path;
	file.extension = path.split('.').pop();
	file.stat = { size: bytes.byteLength, mtime: 1 };
	return file;
}

function makeGroup(files, hash) {
	return {
		hash,
		size: files[0].stat.size,
		files: files.map((file) => ({
			path: file.path,
			extension: file.extension,
			size: file.stat.size,
			mtime: file.stat.mtime,
			referenced: false,
			referencingNotes: [],
		})),
	};
}

function makeHost(vaultFiles, groups, selection, contents) {
	const trashed = [];
	const modalCalls = [];
	const host = {
		app: {
			vault: {
				getFiles: () => vaultFiles,
				getMarkdownFiles: () => [],
				getAbstractFileByPath: (path) => vaultFiles.find((file) => file.path === path) ?? null,
				readBinary: async (file) => {
					const bytes = contents.get(file.path);
					if (!bytes) throw new Error('无法读取文件');
					return bytes;
				},
			},
			metadataCache: { resolvedLinks: {}, getFileCache: () => null, getFirstLinkpathDest: () => null },
			fileManager: { trashFile: async (file) => { trashed.push(file.path); } },
		},
		candidates: { images: [], attachments: [], emptyFiles: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [], duplicates: groups, duplicateWarnings: [] },
		duplicateSelections: new Set(selection),
		selections: new Set(),
		settings: { orphanImageExtensions: 'png', orphanIgnoredFolders: '' },
		activeTab: 'duplicates',
		processed: undefined,
		__modalCalls: modalCalls,
		async scanTab() {},
		saveCacheToSettings() {},
		renderContents() {},
	};
	return { host, trashed };
}

function threeGroups() {
	const sameBytes = new Uint8Array([1, 2, 3]);
	const wholeFiles = [makeFile('whole/a.png', sameBytes), makeFile('whole/b.png', sameBytes)];
	const partialFiles = [makeFile('partial/a.png', sameBytes), makeFile('partial/b.png', sameBytes)];
	const vaultFiles = [...wholeFiles, ...partialFiles];
	const contents = new Map(vaultFiles.map((file) => [file.path, sameBytes]));
	return { wholeFiles, partialFiles, vaultFiles, contents };
}

test('整组全选直接执行删除并提示数量，不再弹确认框', async () => {
	const { wholeFiles, partialFiles, vaultFiles, contents } = threeGroups();
	const groups = [makeGroup(wholeFiles, 'whole-hash'), makeGroup(partialFiles, 'partial-hash')];
	const { host, trashed } = makeHost(vaultFiles, groups, [...wholeFiles, ...partialFiles.slice(0, 1)].map((file) => file.path), contents);

	await confirmCleanupDuplicates(host);

	assert.deepEqual(trashed.sort(), ['partial/a.png', 'whole/a.png', 'whole/b.png']);
	assert.equal(globalThis.__notices.length, 1);
	assert.match(globalThis.__notices[0], /^已删除：3\n跳过：0\n失败：0/);
});

test('部分选中直接执行删除，保留项不进入回收站', async () => {
	const { wholeFiles, partialFiles, vaultFiles, contents } = threeGroups();
	const groups = [makeGroup(wholeFiles, 'whole-hash'), makeGroup(partialFiles, 'partial-hash')];
	const { host, trashed } = makeHost(vaultFiles, groups, ['partial/b.png'], contents);

	await confirmCleanupDuplicates(host);

	assert.deepEqual(trashed, ['partial/b.png']);
	assert.match(globalThis.__notices.at(-1), /^已删除：1\n跳过：0\n失败：0/);
});

test('扫描后内容变化的文件自动跳过并带原因，其余照常删除', async () => {
	const { wholeFiles, partialFiles, vaultFiles, contents } = threeGroups();
	contents.set('whole/b.png', new Uint8Array([9, 9, 9]));
	const groups = [makeGroup(wholeFiles, 'whole-hash'), makeGroup(partialFiles, 'partial-hash')];
	const { host, trashed } = makeHost(vaultFiles, groups, wholeFiles.map((file) => file.path), contents);

	await confirmCleanupDuplicates(host);

	assert.deepEqual(trashed, ['whole/a.png']);
	const notice = globalThis.__notices.at(-1);
	assert.match(notice, /^已删除：1\n跳过：1\n失败：0/);
	assert.match(notice, /whole\/b\.png（文件内容已变化，请重新扫描）/);
});

test('计划校验之后、删除之前发生的内容变化仍会被拦下', async () => {
	const sameBytes = new Uint8Array([1, 2, 3]);
	const keep = makeFile('keep.png', sameBytes);
	const victim = makeFile('victim.png', sameBytes);
	const vaultFiles = [keep, victim];
	const contents = new Map([[keep.path, sameBytes], [victim.path, sameBytes]]);
	const groups = [makeGroup([keep, victim], 'pair-hash')];
	const trashed = [];
	const note = { path: 'ref.md', extension: 'md' };
	let mutated = false;
	const noteContent = '![[victim.png]]';
	const host = {
		app: {
			vault: {
				getFiles: () => vaultFiles,
				getMarkdownFiles: () => [note],
				getAbstractFileByPath: (path) => vaultFiles.find((file) => file.path === path) ?? null,
				readBinary: async (file) => contents.get(file.path),
				process: async (_file, change) => {
					const updated = change(noteContent);
					// 链接清理期间，另一处编辑改写了待删除的重复文件。
					if (!mutated) {
						mutated = true;
						contents.set('victim.png', new Uint8Array([9, 9, 9]));
						victim.stat = { size: 3, mtime: 9 };
					}
					return updated;
				},
			},
			metadataCache: {
				resolvedLinks: { 'ref.md': { 'victim.png': 1 } },
				getFileCache: () => ({ embeds: [{ original: '![[victim.png]]', link: 'victim.png', position: { start: { offset: 0 }, end: { offset: 14 } } }] }),
				getFirstLinkpathDest: (link) => (link === 'victim.png' ? victim : null),
			},
			fileManager: { trashFile: async (file) => { trashed.push(file.path); } },
		},
		candidates: { images: [], attachments: [], emptyFiles: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [], duplicates: groups, duplicateWarnings: [] },
		duplicateSelections: new Set(['victim.png']),
		selections: new Set(),
		settings: { orphanImageExtensions: 'png', orphanIgnoredFolders: '' },
		activeTab: 'duplicates',
		processed: undefined,
		async scanTab() {},
		saveCacheToSettings() {},
		renderContents() {},
	};

	await confirmCleanupDuplicates(host);

	assert.deepEqual(trashed, [], '内容已变化的文件不能进入回收站');
	const notice = globalThis.__notices.at(-1);
	assert.match(notice, /^已删除：0\n跳过：1\n失败：0/);
	assert.match(notice, /victim\.png（文件内容已变化，请重新扫描）/);
});
