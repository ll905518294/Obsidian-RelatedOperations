import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const stub = `
export class TAbstractFile {}
export class TFile extends TAbstractFile {
  constructor(path, size = 10) {
    super();
    this.path = path;
    this.name = path.split('/').pop();
    this.extension = path.split('.').pop();
    this.stat = { size, mtime: 0 };
    // 真实 Obsidian 的 TFile 反向持有 vault，直接 JSON.stringify 会循环。
    this.vault = {};
    this.vault.self = this.vault;
  }
}
export class TFolder extends TAbstractFile {
  constructor(path) {
    super();
    this.path = path;
    this.children = [];
    this.vault = {};
    this.vault.self = this.vault;
  }
}
export class App {}
export class FileSystemAdapter {}
export class Notice { constructor() {} }
export class Component { register() {} registerEvent() {} registerInterval() {} }
export class Modal extends Component {}
export class ItemView extends Component {}
export class PluginSettingTab extends Component {}
export class MarkdownView {}
export const setIcon = () => {};
export const normalizePath = p => p;
export const Platform = {};
`;

const bundle = await build({
	stdin: {
		contents: "export { serializeCleanupCandidates, createCleanupCache, restoreCleanupCandidates } from './src/cleanup/cleanup-cache.ts'; export { TFile, TFolder } from 'obsidian';",
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'node',
	plugins: [{
		name: 'obsidian-stub',
		setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
			b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub }));
		},
	}],
});

const { serializeCleanupCandidates, createCleanupCache, restoreCleanupCandidates, TFile, TFolder } =
	await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function makeCandidates() {
	const image = new TFile('pics/a.png', 100);
	const folder = new TFolder('Empty');
	const note = new TFile('note.md', 5);
	return {
		image,
		folder,
		candidates: {
			images: [image],
			attachments: [],
			emptyFiles: [],
			folders: [folder],
			brokenLinks: [{ sourcePath: 'note.md', original: '![[missing.png]]', linkPath: 'missing.png', position: { start: { offset: 0 }, end: { offset: 16 } } }],
			nativeLinks: [{ sourcePath: 'note.md', original: '![[a.png]]', linkPath: 'a.png', position: { start: { offset: 0 }, end: { offset: 10 } }, file: image }],
			brokenNoteLinks: [{ sourcePath: 'note.md', original: '[[gone]]', linkPath: 'gone', position: { start: { offset: 0 }, end: { offset: 8 } }, syntax: 'wiki' }],
			wikiLinks: [{ sourcePath: 'note.md', original: '[[note]]', linkPath: 'note', position: { start: { offset: 0 }, end: { offset: 8 } }, file: note }],
			duplicates: [{
				hash: 'abc',
				size: 100,
				files: [
					{ path: 'pics/a.png', extension: 'png', size: 100, mtime: 0, referenced: false, referencingNotes: [] },
					{ path: 'pics/b.png', extension: 'png', size: 100, mtime: 0, referenced: false, referencingNotes: ['note.md'] },
				],
			}],
			duplicateWarnings: [{ path: 'pics/broken.png', reason: '无法读取' }],
			convertibleImages: [image],
		},
	};
}

test('serialized candidates contain no Obsidian file objects and survive JSON round-trip', () => {
	const { candidates } = makeCandidates();
	const serialized = serializeCleanupCandidates(candidates);
	assert.doesNotThrow(() => JSON.stringify(serialized), '序列化结果不能含循环引用');
	assert.deepEqual(JSON.parse(JSON.stringify(serialized)), serialized);
	assert.deepEqual(serialized.images, [{ path: 'pics/a.png', size: 100, mtime: 0 }]);
	assert.deepEqual(serialized.folders, [{ path: 'Empty' }]);
	assert.equal('vault' in serialized.images[0], false);
	assert.deepEqual(serialized.nativeLinks[0].file, { path: 'pics/a.png', size: 100, mtime: 0 });
	assert.equal('vault' in serialized.nativeLinks[0].file, false);
	assert.equal(serialized.wikiLinks[0].file.path, 'note.md');
});

test('createCleanupCache produces a versioned, JSON-safe cache', () => {
	const { candidates } = makeCandidates();
	const cache = createCleanupCache('2026-11-17T01:02:03.000Z', candidates, {
		orphanImageExtensions: 'png',
		orphanIgnoredFolders: '',
	});
	assert.equal(cache.version, 2);
	assert.equal(cache.scannedAt, '2026-11-17T01:02:03.000Z');
	assert.deepEqual(cache.settingsSnapshot, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' });
	assert.doesNotThrow(() => JSON.stringify(cache));
	assert.deepEqual(JSON.parse(JSON.stringify(cache)), cache);
});

test('restored candidates resolve serialized paths back to TFile and TFolder', () => {
	const { candidates, image, folder } = makeCandidates();
	const note = new TFile('note.md', 5);
	const secondImage = new TFile('pics/b.png', 100);
	const byPath = new Map([['pics/a.png', image], ['pics/b.png', secondImage], ['Empty', folder], ['note.md', note]]);
	const app = { vault: { getAbstractFileByPath: (path) => byPath.get(path) ?? null } };
	const serialized = JSON.parse(JSON.stringify(serializeCleanupCandidates(candidates)));

	const restored = restoreCleanupCandidates(app, serialized);

	assert.equal(restored.images[0], image);
	assert.ok(restored.images[0] instanceof TFile);
	assert.equal(restored.folders[0], folder);
	assert.ok(restored.folders[0] instanceof TFolder);
	assert.equal(restored.nativeLinks[0].file, image);
	assert.equal(restored.wikiLinks[0].file, note);
	assert.deepEqual(restored.duplicates, candidates.duplicates);
	assert.deepEqual(restored.duplicateWarnings, candidates.duplicateWarnings);
	assert.deepEqual(restored.convertibleImages, []);

	const wrapped = restoreCleanupCandidates(app, createCleanupCache('2026-11-17T01:02:03.000Z', candidates, {
		orphanImageExtensions: 'png',
		orphanIgnoredFolders: '',
	}));
	assert.equal(wrapped.images[0], image, '整份缓存对象也应能直接恢复');
});

test('missing files are dropped without throwing and corrupt entries are ignored', () => {
	const { candidates, image } = makeCandidates();
	const app = {
		vault: {
			getAbstractFileByPath: (path) => {
				if (path === 'pics/a.png') return image;
				throw new Error('lookup failed');
			},
		},
	};
	const serialized = JSON.parse(JSON.stringify(serializeCleanupCandidates(candidates)));
	serialized.attachments = [{ path: 'gone.pdf', size: 1, mtime: 0 }, { nope: true }, null];

	const restored = restoreCleanupCandidates(app, serialized);

	assert.equal(restored.images.length, 1);
	assert.deepEqual(restored.attachments, []);
	assert.doesNotThrow(() => restoreCleanupCandidates(app, {
		images: 'not-an-array',
		nativeLinks: [null, {}, { sourcePath: 'note.md' }],
		duplicates: [{ hash: 'only-hash' }, 'bad'],
		folders: [{ path: 'Empty' }, 42],
	}));
});

test('legacy in-memory candidates with file objects still restore through the vault', () => {
	const { candidates, image } = makeCandidates();
	const byPath = new Map([['pics/a.png', image]]);
	const app = { vault: { getAbstractFileByPath: (path) => byPath.get(path) ?? null } };
	const restored = restoreCleanupCandidates(app, candidates);
	assert.equal(restored.images[0], image);
	assert.equal(restored.attachments.length, 0);
});

test('版本不匹配的缓存整体失效，当前版本仍可恢复', () => {
	const { candidates, image } = makeCandidates();
	const byPath = new Map([['pics/a.png', image]]);
	const app = { vault: { getAbstractFileByPath: (path) => byPath.get(path) ?? null } };
	const cache = createCleanupCache('2026-11-17T01:02:03.000Z', candidates, {
		orphanImageExtensions: 'png',
		orphanIgnoredFolders: '',
	});

	const staleCache = JSON.parse(JSON.stringify(cache));
	staleCache.version = 1;
	assert.deepEqual(restoreCleanupCandidates(app, staleCache).images, []);

	const staleCandidates = JSON.parse(JSON.stringify(serializeCleanupCandidates(candidates)));
	staleCandidates.cacheVersion = 1;
	assert.deepEqual(restoreCleanupCandidates(app, staleCandidates).images, [], '候选数据自带版本标记时也要校验');

	const freshCandidates = JSON.parse(JSON.stringify(serializeCleanupCandidates(candidates)));
	assert.equal(restoreCleanupCandidates(app, freshCandidates).images[0], image);
});

test('恢复缓存时丢弃内容已变化的空文件，保留未变化的条目', () => {
	const kept = new TFile('empty-kept.md', 0);
	kept.stat = { size: 0, mtime: 7 };
	const changed = new TFile('empty-changed.md', 0);
	changed.stat = { size: 0, mtime: 8 };
	const candidates = {
		images: [], attachments: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [], duplicates: [], duplicateWarnings: [], convertibleImages: [],
		emptyFiles: [kept, changed],
	};
	const app = {
		vault: {
			getAbstractFileByPath: (path) => {
				if (path === 'empty-kept.md') return kept;
				if (path === 'empty-changed.md') {
					const current = new TFile('empty-changed.md', 12);
					current.stat = { size: 12, mtime: 9 };
					return current;
				}
				return null;
			},
		},
	};
	const restored = restoreCleanupCandidates(app, JSON.parse(JSON.stringify(serializeCleanupCandidates(candidates))));
	assert.deepEqual(restored.emptyFiles.map((file) => file.path), ['empty-kept.md']);
});

test('恢复缓存时图片只要求路径存在，内容变化不影响未引用判定', () => {
	const image = new TFile('pics/a.png', 100);
	image.stat = { size: 100, mtime: 1 };
	const current = new TFile('pics/a.png', 240);
	current.stat = { size: 240, mtime: 9 };
	const candidates = {
		images: [image], attachments: [], emptyFiles: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [], duplicates: [], duplicateWarnings: [], convertibleImages: [],
	};
	const app = { vault: { getAbstractFileByPath: (path) => (path === 'pics/a.png' ? current : null) } };
	const restored = restoreCleanupCandidates(app, JSON.parse(JSON.stringify(serializeCleanupCandidates(candidates))));
	assert.equal(restored.images[0], current);
});

test('恢复重复文件分组时剔除已删除或已变化的文件，剩余不足两个则丢弃分组', () => {
	const files = [
		new TFile('dup/a.bin', 3),
		new TFile('dup/b.bin', 3),
		new TFile('dup/gone.bin', 3),
		new TFile('dup/changed.bin', 3),
	];
	for (const file of files) file.stat = { size: 3, mtime: 4 };
	const group = {
		hash: 'same',
		size: 3,
		files: files.map((file) => ({ path: file.path, extension: 'bin', size: 3, mtime: 4, referenced: false, referencingNotes: [] })),
	};
	const changedNow = new TFile('dup/changed.bin', 4);
	changedNow.stat = { size: 4, mtime: 5 };
	const byPath = new Map([
		['dup/a.bin', files[0]],
		['dup/b.bin', files[1]],
		['dup/changed.bin', changedNow],
	]);
	const candidates = {
		images: [], attachments: [], emptyFiles: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [], duplicateWarnings: [], convertibleImages: [],
		duplicates: [group],
	};
	const app = { vault: { getAbstractFileByPath: (path) => byPath.get(path) ?? null } };
	const restored = restoreCleanupCandidates(app, JSON.parse(JSON.stringify(serializeCleanupCandidates(candidates))));
	assert.deepEqual(restored.duplicates.map((item) => item.files.map((file) => file.path)), [['dup/a.bin', 'dup/b.bin']]);
});

test('重复文件分组剩余一个文件时整体丢弃', () => {
	const kept = new TFile('dup/a.bin', 3);
	kept.stat = { size: 3, mtime: 4 };
	const vanished = new TFile('dup/b.bin', 3);
	vanished.stat = { size: 3, mtime: 4 };
	const group = {
		hash: 'same',
		size: 3,
		files: [kept, vanished].map((file) => ({ path: file.path, extension: 'bin', size: 3, mtime: 4, referenced: false, referencingNotes: [] })),
	};
	const candidates = {
		images: [], attachments: [], emptyFiles: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [], duplicateWarnings: [], convertibleImages: [],
		duplicates: [group],
	};
	const app = { vault: { getAbstractFileByPath: (path) => (path === 'dup/a.bin' ? kept : null) } };
	assert.deepEqual(restoreCleanupCandidates(app, JSON.parse(JSON.stringify(serializeCleanupCandidates(candidates)))).duplicates, []);
});
