import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicateFiles } from '../src/duplicate-files.ts';

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
