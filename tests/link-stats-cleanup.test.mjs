import test from 'node:test';
import assert from 'node:assert/strict';
import {
	collectLinkStatsPropertyEntries,
	removeLinkStatsPropertyEntries,
	HISTORICAL_LINK_STATS_PROPERTY_NAMES,
} from '../src/link-stats-cleanup.ts';

const NAMES = [
	'related-operations-in-links',
	'related-operations-out-links',
	'related-operations-bidirectional-links',
];

test('cleanup collects only the target keys and preserves every other field', () => {
	const entries = collectLinkStatsPropertyEntries([
		{
			path: 'a.md',
			frontmatter: {
				title: 'keep me',
				'related-operations-in-links': 3,
				'related-operations-out-links': 2,
				'related-operations-bidirectional-links': 1,
				tags: ['x', 'y'],
			},
		},
		{ path: 'b.md', frontmatter: { title: 'no stats' } },
	], NAMES);
	assert.deepEqual(entries, [
		{
			path: 'a.md',
			matchedKeys: [
				'related-operations-in-links',
				'related-operations-out-links',
				'related-operations-bidirectional-links',
			],
		},
	]);
});

test('cleanup does not pick up unrelated fields sharing a prefix', () => {
	const entries = collectLinkStatsPropertyEntries([
		{ path: 'a.md', frontmatter: { 'related-operations-in-links-extra': 1, 'related-operations-in-links': 1 } },
	], NAMES);
	assert.deepEqual(entries, [{ path: 'a.md', matchedKeys: ['related-operations-in-links'] }]);
});

test('cleanup finds custom historical names', () => {
	const custom = ['我的入链', '我的出链', '我的双向'];
	const entries = collectLinkStatsPropertyEntries([
		{ path: 'a.md', frontmatter: { '我的入链': 3, title: 'keep' } },
		{ path: 'b.md', frontmatter: { '无关字段': 1 } },
	], custom);
	assert.deepEqual(entries, [{ path: 'a.md', matchedKeys: ['我的入链'] }]);
});

test('cleanup reports an empty result when nothing matches', () => {
	const entries = collectLinkStatsPropertyEntries([
		{ path: 'a.md', frontmatter: { title: 'x' } },
		{ path: 'b.md', frontmatter: null },
		{ path: 'c.md', frontmatter: undefined },
	], NAMES);
	assert.deepEqual(entries, []);
});

test('historical defaults match the names the plugin ever wrote', () => {
	assert.deepEqual(
		[HISTORICAL_LINK_STATS_PROPERTY_NAMES.incomingProperty, HISTORICAL_LINK_STATS_PROPERTY_NAMES.outgoingProperty, HISTORICAL_LINK_STATS_PROPERTY_NAMES.bidirectionalProperty],
		NAMES,
	);
});

test('removeLinkStatsPropertyEntries skips notes and keeps going after a failure', async () => {
	const removed = [];
	const summary = await removeLinkStatsPropertyEntries(
		[
			{ path: 'a.md', matchedKeys: NAMES },
			{ path: 'b.md', matchedKeys: ['in'] },
			{ path: 'c.md', matchedKeys: ['in'] },
			{ path: 'd.md', matchedKeys: ['in'] },
		],
		async (path, keys) => {
			removed.push([path, keys]);
			if (path === 'c.md') throw new Error('disk busy');
		},
		(path) => path === 'b.md',
	);
	assert.deepEqual(summary.cleaned, 2);
	assert.deepEqual(summary.skipped, 1);
	assert.deepEqual(summary.failed, [{ path: 'c.md', reason: 'disk busy' }]);
	assert.deepEqual(removed, [
		['a.md', NAMES],
		['c.md', ['in']],
		['d.md', ['in']],
	]);
});
