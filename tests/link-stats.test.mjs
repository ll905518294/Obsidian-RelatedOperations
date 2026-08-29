import test from 'node:test';
import assert from 'node:assert/strict';
import { findLinkStatsPropertyNameConflicts } from '../src/link-stats-core.ts';

test('blocks a new link-stat property name that would overwrite existing frontmatter', () => {
	assert.deepEqual(
		findLinkStatsPropertyNameConflicts(
			{ title: 'Existing title', oldIncoming: 1 },
			['oldIncoming', 'oldOutgoing', 'oldBidirectional'],
			['title', 'newOutgoing', 'newBidirectional'],
		),
		['title'],
	);
});

test('allows renaming properties when new names do not exist', () => {
	assert.deepEqual(
		findLinkStatsPropertyNameConflicts(
			{ oldIncoming: 1 },
			['oldIncoming', 'oldOutgoing', 'oldBidirectional'],
			['newIncoming', 'newOutgoing', 'newBidirectional'],
		),
		[],
	);
});
