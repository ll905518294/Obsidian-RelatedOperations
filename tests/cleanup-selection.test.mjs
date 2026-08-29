import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCurrentCleanupItems } from '../src/cleanup-selection.ts';

test('keeps only selected items that are still cleanup candidates', () => {
	assert.deepEqual(
		selectCurrentCleanupItems(['old.png', 'still.png'], [{ path: 'still.png' }, { path: 'other.png' }]),
		{ items: [{ path: 'still.png' }], skipped: ['old.png'] },
	);
});
