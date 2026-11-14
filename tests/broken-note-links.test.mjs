import test from 'node:test';
import assert from 'node:assert/strict';
import { createMissingNotes, missingNotePath, removeBrokenNoteLinks } from '../src/broken-note-links.ts';

const link = {
	sourcePath: 'note.md',
	original: '[[missing]]',
	linkPath: 'missing',
	position: { start: { offset: 0 }, end: { offset: 11 } },
	syntax: 'wiki',
};

test('does not create a note when the selected broken link was removed after scanning', async () => {
	let created = false;
	const app = {
		metadataCache: { getFirstLinkpathDest: () => null },
		vault: {
			getAllLoadedFiles: () => [{ path: 'note.md' }],
			getFileByPath: () => ({ path: 'note.md', extension: 'md' }),
			read: async () => 'changed',
			create: async () => { created = true; },
		},
	};
	const result = await createMissingNotes(app, [link]);
	assert.deepEqual(result, { created: [], skipped: [{ path: 'missing.md', reason: '链接已变化或目标已恢复' }], failed: [] });
	assert.equal(created, false);
});

test('rejects Windows drive-relative paths from missing note creation', () => {
	const drive = { sourcePath: 'note.md', linkPath: 'C:target', original: '[[C:target]]', position: { start: { offset: 0 }, end: { offset: 11 } }, syntax: 'wiki' };
	assert.equal(missingNotePath(drive), null);
});

test('removes multiple wiki links sharing one line and nested anchors', () => {
	const link = (offset) => {
		const original = '[[missing]]';
		return { sourcePath: 'note.md', original, linkPath: 'missing', position: { start: { offset }, end: { offset: offset + original.length } }, syntax: 'wiki' };
	};
	const content = '[[missing]] and [[missing]] and after';
	const target = '[[missing]]';
	const a = content.indexOf(target);
	const b = content.indexOf(target, a + target.length);
	const l1 = { ...link(a), position: { start: { offset: a }, end: { offset: a + target.length } } };
	const l2 = { ...link(b), position: { start: { offset: b }, end: { offset: b + target.length } } };
	const result = removeBrokenNoteLinks(content, [l1, l2]);
	assert.equal(result.content, ' and  and after');
	assert.equal(result.removed, 2);
	assert.equal(result.skipped, 0);
});
