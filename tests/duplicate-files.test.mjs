import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicateFiles, planDuplicateDeletion, removeFileReferencesForFiles } from '../src/duplicate-files.ts';

function appFor(files, contents, resolvedLinks = {}) {
	return {
		vault: {
			getFiles: () => files,
			getAbstractFileByPath: (path) => files.find((file) => file.path === path) ?? null,
			readBinary: async (file) => {
				const content = contents[file.path];
				if (!content) throw new Error('无法读取文件');
				return content;
			},
		},
		metadataCache: { resolvedLinks },
	};
}

function duplicateGroup(files, hash = 'dup-hash') {
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

test('groups exact duplicate content across names and extensions', async () => {
	const files = [
		{ path: 'a.png', extension: 'png', stat: { size: 3, mtime: 1 } },
		{ path: 'copy.md', extension: 'md', stat: { size: 3, mtime: 2 } },
		{ path: 'different.png', extension: 'png', stat: { size: 4, mtime: 3 } },
	];
	const result = await findDuplicateFiles(appFor(files, { 'a.png': new Uint8Array([1, 2, 3]), 'copy.md': new Uint8Array([1, 2, 3]), 'different.png': new Uint8Array([1, 2, 3, 4]) }));
	assert.equal(result.groups.length, 1);
	assert.deepEqual(result.groups[0].files.map((file) => file.path), ['a.png', 'copy.md']);
	assert.deepEqual(result.groups[0].files[0].referencingNotes, []);
});

test('excludes hidden, ignored, Canvas and single-file groups, and records read warnings', async () => {
	const files = [
		{ path: '.obsidian/a.png', extension: 'png', stat: { size: 1, mtime: 1 } },
		{ path: 'ignored/a.png', extension: 'png', stat: { size: 1, mtime: 1 } },
		{ path: 'board.canvas', extension: 'canvas', stat: { size: 1, mtime: 1 } },
		{ path: 'ok.bin', extension: 'bin', stat: { size: 1, mtime: 1 } },
		{ path: 'bad.bin', extension: 'bin', stat: { size: 1, mtime: 1 } },
	];
	const result = await findDuplicateFiles({
		vault: { getFiles: () => files, readBinary: async (file) => { if (file.path === 'bad.bin') throw new Error('拒绝访问'); return new Uint8Array([7]); } },
		metadataCache: { resolvedLinks: { 'note.md': { 'ok.bin': 1 } } },
	}, 'ignored');
	assert.deepEqual(result.groups, []);
	assert.deepEqual(result.warnings, [{ path: 'bad.bin', reason: '拒绝访问' }]);
});

test('removes image and regular file references before duplicate deletion', async () => {
	const note = { path: 'note.md', extension: 'md' };
	let content = '![[photo.png]] and [document](document.pdf)';
	const files = [{ path: 'photo.png' }, { path: 'document.pdf' }];
	const app = {
		vault: {
			getMarkdownFiles: () => [note],
			process: async (_file, callback) => { content = callback(content); },
		},
		metadataCache: {
			getFileCache: () => ({ embeds: [{ original: '![[photo.png]]', link: 'photo.png', position: { start: { offset: 0 }, end: { offset: 14 } } }], links: [{ original: '[document](document.pdf)', link: 'document.pdf', position: { start: { offset: 19 }, end: { offset: 43 } } }] }),
			getFirstLinkpathDest: (path) => files.find((file) => file.path === path),
		},
	};
	const result = await removeFileReferencesForFiles(app, files.map((file) => file.path));
	assert.equal(result.failed.length, 0);
	assert.equal(result.removed, 2);
	assert.equal(content, ' and ');
});

test('re-locates references when cached offsets are stale after an edit', async () => {
	const note = { path: 'note.md', extension: 'md' };
	let content = 'edited intro ![[photo.png]] tail';
	const photo = { path: 'photo.png' };
	const app = {
		vault: {
			getMarkdownFiles: () => [note],
			process: async (_file, callback) => { content = callback(content); },
		},
		metadataCache: {
			getFileCache: () => ({ embeds: [{ original: '![[photo.png]]', link: 'photo.png', position: { start: { offset: 0 }, end: { offset: 13 } } }] }),
			getFirstLinkpathDest: (path) => (path === 'photo.png' ? photo : null),
		},
	};
	const result = await removeFileReferencesForFiles(app, ['photo.png']);
	assert.equal(result.failed.length, 0);
	assert.equal(result.removed, 1);
	assert.ok(!content.includes('![[photo.png]]'), `reference still present: ${content}`);
});

test('reports a failure when an unremovable reference to a target remains', async () => {
	const note = { path: 'note.md', extension: 'md' };
	// The cache only knows one of two identical references, so one would survive.
	let content = '![[photo.png]] and ![[photo.png]]';
	const photo = { path: 'photo.png' };
	const app = {
		vault: {
			getMarkdownFiles: () => [note],
			process: async (_file, callback) => { content = callback(content); },
		},
		metadataCache: {
			getFileCache: () => ({ embeds: [{ original: '![[photo.png]]', link: 'photo.png', position: { start: { offset: 0 }, end: { offset: 13 } } }] }),
			getFirstLinkpathDest: (path) => (path === 'photo.png' ? photo : null),
		},
	};
	const result = await removeFileReferencesForFiles(app, ['photo.png']);
	assert.equal(result.failed.length, 1);
	assert.ok(result.failed[0].includes('note.md'));
});

test('does not hash single-file size groups so unique files skip expensive reads', async () => {
	let reads = 0;
	const files = [
		{ path: 'solo.md', extension: 'md', stat: { size: 7, mtime: 1 } },
		{ path: 'dup1.bin', extension: 'bin', stat: { size: 5, mtime: 1 } },
		{ path: 'dup2.bin', extension: 'bin', stat: { size: 5, mtime: 2 } },
	];
	const result = await findDuplicateFiles({
		vault: { getFiles: () => files, readBinary: async (file) => { reads++; return new Uint8Array([9, 9, 9, 9, 9]); } },
		metadataCache: { resolvedLinks: {} },
	});
	assert.equal(reads, 2);
	assert.equal(result.groups.length, 1);
	assert.deepEqual(result.groups[0].files.map((file) => file.path), ['dup1.bin', 'dup2.bin']);
});

test('treats zero-byte files with identical content as duplicates', async () => {
	const files = [
		{ path: 'a.txt', extension: 'txt', stat: { size: 0, mtime: 1 } },
		{ path: 'b.txt', extension: 'txt', stat: { size: 0, mtime: 2 } },
	];
	const result = await findDuplicateFiles({
		vault: { getFiles: () => files, readBinary: async () => new Uint8Array(0) },
		metadataCache: { resolvedLinks: {} },
	});
	assert.equal(result.groups.length, 1);
	assert.equal(result.groups[0].size, 0);
	assert.deepEqual(result.groups[0].files.map((file) => file.path), ['a.txt', 'b.txt']);
	assert.deepEqual(result.warnings, []);
});

test('reports referencing notes once per duplicate without rescanning per file', async () => {
	const files = [
		{ path: 'a.png', extension: 'png', stat: { size: 3, mtime: 1 } },
		{ path: 'b.png', extension: 'png', stat: { size: 3, mtime: 2 } },
	];
	const result = await findDuplicateFiles({
		vault: { getFiles: () => files, readBinary: async () => new Uint8Array([1, 2, 3]) },
		metadataCache: {
			resolvedLinks: {
				'note-one.md': { 'a.png': 1 },
				'note-two.md': { 'a.png': 1, 'b.png': 1 },
			},
		},
	});
	const byPath = Object.fromEntries(result.groups[0].files.map((file) => [file.path, file]));
	assert.deepEqual(byPath['a.png'].referencingNotes, ['note-one.md', 'note-two.md']);
	assert.deepEqual(byPath['b.png'].referencingNotes, ['note-two.md']);
	assert.equal(byPath['a.png'].referenced, true);
	assert.equal(byPath['b.png'].referenced, true);
});

test('refuses to edit when a resolved reference cannot be located in the cache', async () => {
	const note = { path: 'note.md', extension: 'md' };
	let content = '![[photo.png]] and [x](<photo.png>)';
	let writes = 0;
	const photo = { path: 'photo.png' };
	const app = {
		vault: {
			getMarkdownFiles: () => [note],
			process: async (_file, callback) => { writes += 1; content = callback(content); },
		},
		metadataCache: {
			// The cache has not indexed the note yet, but Obsidian already resolved
			// two links to the target. Removing only the visible ones would strand a
			// link, so the whole removal pass must refuse.
			getFileCache: () => null,
			getFirstLinkpathDest: (path) => (path === 'photo.png' ? photo : null),
			resolvedLinks: { 'note.md': { 'photo.png': 2 } },
		},
	};
	const result = await removeFileReferencesForFiles(app, ['photo.png']);
	assert.equal(result.removed, 0);
	assert.equal(result.failed.length, 1);
	assert.ok(result.failed[0].includes('note.md'), result.failed[0]);
	assert.equal(writes, 0);
	assert.equal(content, '![[photo.png]] and [x](<photo.png>)');
});

test('removes references when every resolved link is present in the cache', async () => {
	const note = { path: 'note.md', extension: 'md' };
	let content = '![[photo.png]] and ![[photo.png]]';
	const photo = { path: 'photo.png' };
	const app = {
		vault: {
			getMarkdownFiles: () => [note],
			process: async (_file, callback) => { content = callback(content); },
		},
		metadataCache: {
			getFileCache: () => ({
				embeds: [
					{ original: '![[photo.png]]', link: 'photo.png', position: { start: { offset: 0 }, end: { offset: 13 } } },
					{ original: '![[photo.png]]', link: 'photo.png', position: { start: { offset: 18 }, end: { offset: 31 } } },
				],
			}),
			getFirstLinkpathDest: (path) => (path === 'photo.png' ? photo : null),
			resolvedLinks: { 'note.md': { 'photo.png': 2 } },
		},
	};
	const result = await removeFileReferencesForFiles(app, ['photo.png']);
	assert.equal(result.failed.length, 0);
	assert.equal(result.removed, 2);
	assert.equal(content, ' and ');
});

function duplicateFiles() {
	return [
		{ path: 'a.png', extension: 'png', stat: { size: 3, mtime: 1 } },
		{ path: 'b.png', extension: 'png', stat: { size: 3, mtime: 2 } },
	];
}

const threeBytes = new Uint8Array([1, 2, 3]);
const replacedBytes = new Uint8Array([9, 9, 9]);

test('deletes every file of a fully selected duplicate group when they still match', async () => {
	const files = duplicateFiles();
	const contents = { 'a.png': threeBytes, 'b.png': threeBytes };
	const plan = await planDuplicateDeletion(appFor(files, contents), [duplicateGroup(files)], ['a.png', 'b.png']);
	assert.deepEqual(plan.deletable.map((file) => file.path), ['a.png', 'b.png']);
	assert.deepEqual(plan.skipped, []);
});

test('skips only the changed file when a fully selected group no longer matches', async () => {
	const files = duplicateFiles();
	// The first selected file is the reference copy; b.png changed after the
	// scan, so it is skipped while a.png still deletes.
	const contents = { 'a.png': threeBytes, 'b.png': replacedBytes };
	const plan = await planDuplicateDeletion(appFor(files, contents), [duplicateGroup(files)], ['a.png', 'b.png']);
	assert.deepEqual(plan.deletable.map((file) => file.path), ['a.png']);
	assert.deepEqual(plan.skipped, [{ path: 'b.png', reason: '文件内容已变化，请重新扫描' }]);
});

test('keeps the unselected copy and only lets selected duplicates through', async () => {
	const files = duplicateFiles();
	const contents = { 'a.png': threeBytes, 'b.png': threeBytes };
	const plan = await planDuplicateDeletion(appFor(files, contents), [duplicateGroup(files)], ['a.png']);
	assert.deepEqual(plan.deletable.map((file) => file.path), ['a.png']);
	assert.deepEqual(plan.skipped, []);
});

test('refuses to delete a selected file whose bytes no longer match the retained copy', async () => {
	const files = duplicateFiles();
	// b.png was rewritten after the scan with the same length, so only the hash
	// comparison can catch it.
	const contents = { 'a.png': threeBytes, 'b.png': replacedBytes };
	const plan = await planDuplicateDeletion(appFor(files, contents), [duplicateGroup(files)], ['b.png']);
	assert.deepEqual(plan.deletable, []);
	assert.deepEqual(plan.skipped, [{ path: 'b.png', reason: '文件内容已变化，请重新扫描' }]);
});

test('refuses selected paths that are no longer part of any group', async () => {
	const files = duplicateFiles();
	const contents = { 'a.png': threeBytes, 'b.png': threeBytes };
	const plan = await planDuplicateDeletion(appFor(files, contents), [duplicateGroup(files)], ['gone.png']);
	assert.deepEqual(plan.deletable, []);
	assert.deepEqual(plan.skipped, [{ path: 'gone.png', reason: '重复分组已变化，请重新扫描' }]);
});

test('skips the group when the retained file cannot be read', async () => {
	const files = duplicateFiles();
	const contents = { 'b.png': threeBytes };
	const plan = await planDuplicateDeletion(appFor(files, contents), [duplicateGroup(files)], ['b.png']);
	assert.deepEqual(plan.deletable, []);
	assert.equal(plan.skipped.length, 1);
	assert.equal(plan.skipped[0].path, 'b.png');
	assert.match(plan.skipped[0].reason, /无法读取保留文件/);
});

test('reports the reason when the selected file cannot be read', async () => {
	const files = duplicateFiles();
	const contents = { 'a.png': threeBytes };
	const plan = await planDuplicateDeletion(appFor(files, contents), [duplicateGroup(files)], ['b.png']);
	assert.deepEqual(plan.deletable, []);
	assert.equal(plan.skipped.length, 1);
	assert.equal(plan.skipped[0].path, 'b.png');
	assert.match(plan.skipped[0].reason, /无法读取文件/);
});
