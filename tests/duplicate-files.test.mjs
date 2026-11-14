import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicateFiles, removeFileReferencesForFiles } from '../src/duplicate-files.ts';

function appFor(files, contents, resolvedLinks = {}) {
	return {
		vault: {
			getFiles: () => files,
			readBinary: async (file) => contents[file.path],
		},
		metadataCache: { resolvedLinks },
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
