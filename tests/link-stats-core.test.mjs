import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLinkStatsIndex, findChangedLinkPaths, findLinkStatsPropertyNameConflicts } from '../src/link-stats-core.ts';

test('findChangedLinkPaths includes removed sources and their targets', () => {
	assert.deepEqual(
		[...findChangedLinkPaths(
			{ 'old-source.md': { 'target.md': 1 }, 'a.md': { 'b.md': 1 } },
			{ 'a.md': { 'b.md': 1 } },
		)].sort(),
		['old-source.md', 'target.md'],
	);
});

test('findChangedLinkPaths reports both endpoints when a link is added', () => {
	assert.deepEqual(
		[...findChangedLinkPaths({ 'a.md': {} }, { 'a.md': { 'b.md': 1 } })].sort(),
		['a.md', 'b.md'],
	);
});

test('findChangedLinkPaths treats a renamed source as changed on both sides', () => {
	assert.deepEqual(
		[...findChangedLinkPaths(
			{ 'old/name.md': { 'target.md': 1 } },
			{ 'new/name.md': { 'target.md': 1 } },
		)].sort(),
		['new/name.md', 'old/name.md', 'target.md'],
	);
});

test('findChangedLinkPaths detects a changed target set for the same source', () => {
	assert.deepEqual(
		[...findChangedLinkPaths(
			{ 'a.md': { 'b.md': 1 } },
			{ 'a.md': { 'c.md': 1 } },
		)].sort(),
		['a.md', 'b.md', 'c.md'],
	);
});

test('findChangedLinkPaths does not conflate paths that differ only by case', () => {
	assert.deepEqual(
		[...findChangedLinkPaths({ 'Note.md': { 'Target.md': 1 } }, { 'note.md': { 'target.md': 1 } })].sort(),
		['Note.md', 'Target.md', 'note.md', 'target.md'],
	);
});

test('buildLinkStatsIndex ignores non-markdown endpoints', () => {
	const stats = buildLinkStatsIndex(
		{ 'note.md': { 'image.png': 1 }, 'image.png': { 'note.md': 1 } },
		new Set(['note.md', 'image.png']),
		new Set(['note.md']),
	);
	assert.deepEqual(stats.get('note.md'), { incoming: 0, outgoing: 0, bidirectional: 0 });
	assert.deepEqual(stats.get('image.png'), { incoming: 0, outgoing: 0, bidirectional: 0 });
});

test('buildLinkStatsIndex counts bidirectional only for mutual links', () => {
	const stats = buildLinkStatsIndex(
		{
			'a.md': { 'b.md': 1, 'c.md': 1 },
			'b.md': { 'a.md': 1 },
			'd.md': { 'a.md': 1 },
		},
		new Set(['a.md', 'b.md', 'c.md', 'd.md']),
		new Set(['a.md', 'b.md', 'c.md', 'd.md']),
	);
	assert.deepEqual(stats.get('a.md'), { incoming: 2, outgoing: 2, bidirectional: 1 });
	assert.deepEqual(stats.get('b.md'), { incoming: 1, outgoing: 1, bidirectional: 1 });
	assert.deepEqual(stats.get('c.md'), { incoming: 1, outgoing: 0, bidirectional: 0 });
	assert.deepEqual(stats.get('d.md'), { incoming: 0, outgoing: 1, bidirectional: 0 });
});

test('buildLinkStatsIndex supports refreshing a subset of notes', () => {
	const stats = buildLinkStatsIndex(
		{ 'a.md': { 'b.md': 1 }, 'b.md': { 'a.md': 1 } },
		new Set(['b.md']),
		new Set(['a.md', 'b.md']),
	);
	assert.equal(stats.size, 1);
	assert.deepEqual(stats.get('b.md'), { incoming: 1, outgoing: 1, bidirectional: 1 });
});

test('property conflicts ignore names kept from the previous settings', () => {
	assert.deepEqual(
		findLinkStatsPropertyNameConflicts(
			{ kept: 1, existing: 2 },
			['kept', 'oldOut'],
			['kept', 'existing'],
		),
		['existing'],
	);
});

test('property conflicts handle missing frontmatter', () => {
	assert.deepEqual(findLinkStatsPropertyNameConflicts(undefined, [], ['new']), []);
});
