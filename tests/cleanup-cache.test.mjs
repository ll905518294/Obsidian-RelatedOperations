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
	const byPath = new Map([['pics/a.png', image], ['Empty', folder], ['note.md', note]]);
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
