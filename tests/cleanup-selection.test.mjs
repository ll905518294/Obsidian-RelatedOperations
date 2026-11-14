import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCurrentCleanupItems } from '../src/cleanup-selection.ts';

test('keeps only selected items that are still cleanup candidates', () => {
	assert.deepEqual(
		selectCurrentCleanupItems(['old.png', 'still.png'], [{ path: 'still.png' }, { path: 'other.png' }]),
		{ items: [{ path: 'still.png' }], skipped: ['old.png'] },
	);
});

test('dedupes the selected set but keeps duplicate current entries', () => {
	assert.deepEqual(selectCurrentCleanupItems(['a', 'a'], [{ path: 'a' }]), { items: [{ path: 'a' }], skipped: [] });
	assert.deepEqual(selectCurrentCleanupItems(['a'], [{ path: 'a' }, { path: 'a' }]), { items: [{ path: 'a' }, { path: 'a' }], skipped: [] });
});

test('returns empty selection unchanged and reports every stale path', () => {
	assert.deepEqual(selectCurrentCleanupItems([], [{ path: 'a' }]), { items: [], skipped: [] });
	assert.deepEqual(selectCurrentCleanupItems(['x', 'y'], [{ path: 'a' }]), { items: [], skipped: ['x', 'y'] });
});

test('accepts any iterable for selected paths', () => {
	assert.deepEqual(
		selectCurrentCleanupItems(new Set(['a', 'b']), [{ path: 'b' }]),
		{ items: [{ path: 'b' }], skipped: ['a'] },
	);
});

test('matches paths exactly instead of by prefix', () => {
	assert.deepEqual(
		selectCurrentCleanupItems(['notes'], [{ path: 'notes/a.md' }]),
		{ items: [], skipped: ['notes'] },
	);
});
