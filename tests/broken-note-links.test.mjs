import test from 'node:test';
import assert from 'node:assert/strict';
import { createMissingNotes } from '../src/broken-note-links.ts';

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
