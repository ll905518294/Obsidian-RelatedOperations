import test from 'node:test';
import assert from 'node:assert/strict';
import {
	brokenLinkKey,
	findBrokenLinkOffset,
	findBrokenImageLinks,
	removeBrokenImageLinks,
	removeSelectedBrokenLinks,
} from '../src/broken-image-links.ts';

function position(start, end) {
	return { start: { offset: start }, end: { offset: end } };
}

function makeApp(files, caches, existing = new Set()) {
	return {
		vault: {
			getMarkdownFiles: () => files.map((path) => ({ path })),
		},
		metadataCache: {
			getFileCache: (file) => caches[file.path] ?? null,
			getFirstLinkpathDest: (linkPath) => existing.has(linkPath) ? { path: linkPath } : null,
		},
	};
}

test('finds unresolved local Markdown and Wiki image links only', () => {
	const missing = './assets/初步设计 扩初 施工图/file-20260823013601193.png';
	const cache = {
		embeds: [
			{ original: `![missing](${missing})`, link: missing, position: position(0, 90) },
			{ original: '![exists](assets/existing.png)', link: './assets/existing.png', position: position(95, 123) },
		],
		links: [
			{ original: '[text](./missing-picture.webp)', link: './missing-picture.webp', position: position(125, 155) },
			{ original: '[text](https://example.com/no.png)', link: 'https://example.com/no.png', position: position(157, 189) },
			{ original: '[text](./notes/plan.md)', link: './notes/plan.md', position: position(191, 211) },
		],
	};
	const app = makeApp(['note.md'], { 'note.md': cache }, new Set(['./assets/existing.png']));
	const links = findBrokenImageLinks(app, 'png, webp');
	assert.deepEqual(links.map((link) => link.linkPath), [missing, './missing-picture.webp']);
});

test('ignores links located in code blocks or frontmatter', () => {
	const cache = {
		frontmatterPosition: position(0, 35),
		sections: [{ type: 'code', position: position(45, 95) }],
		links: [
			{ original: '[frontmatter](missing.png)', link: 'missing.png', position: position(10, 34) },
			{ original: '[code](missing.png)', link: 'missing.png', position: position(55, 75) },
			{ original: '[normal](missing.png)', link: 'missing.png', position: position(100, 124) },
		],
	};
	const app = makeApp(['note.md'], { 'note.md': cache });
	const links = findBrokenImageLinks(app, 'png');
	assert.equal(links.length, 1);
	assert.equal(links[0].original, '[normal](missing.png)');
});

test('removes a line-only link without leaving a blank line', () => {
	const original = '![missing](./assets/a b.png)';
	const link = {
		sourcePath: 'note.md',
		original,
		linkPath: './assets/a b.png',
		position: position(6, 6 + original.length),
	};
	const result = removeBrokenImageLinks(`Keep\n\n${original}\nAfter`, [link]);
	assert.equal(result.content, 'Keep\n\nAfter');
	assert.deepEqual({ removed: result.removed, skipped: result.skipped }, { removed: 1, skipped: 0 });
});

test('keeps surrounding prose when a link is not alone on its line', () => {
	const original = '[missing](missing.webp)';
	const link = {
		sourcePath: 'note.md',
		original,
		linkPath: 'missing.webp',
		position: position(5, 5 + original.length),
	};
	const result = removeBrokenImageLinks(`See  ${original}  now`, [link]);
	assert.equal(result.content, 'See    now');
});

test('removes multiple selected links safely', () => {
	const first = '![[missing-one.png]]';
	const second = '[[missing-two.webp]]';
	const content = `A ${first} B ${second} C`;
	const links = [
		{
			sourcePath: 'note.md',
			original: first,
			linkPath: 'missing-one.png',
			position: position(2, 2 + first.length),
		},
		{
			sourcePath: 'note.md',
			original: second,
			linkPath: 'missing-two.webp',
			position: position(2 + first.length + 3, 2 + first.length + 3 + second.length),
		},
	];
	const result = removeBrokenImageLinks(content, links);
	assert.equal(result.content, 'A  B  C');
	assert.equal(result.removed, 2);
});

test('skips a cached position that no longer matches the note', () => {
	const original = '[missing](missing.png)';
	const link = {
		sourcePath: 'note.md',
		original,
		linkPath: 'missing.png',
		position: position(0, original.length),
	};
	const result = removeBrokenImageLinks('[changed](changed.png)', [link]);
	assert.equal(result.content, '[changed](changed.png)');
	assert.deepEqual({ removed: result.removed, skipped: result.skipped }, { removed: 0, skipped: 1 });
});

test('locates a link from cache or by searching changed content', () => {
	const link = {
		sourcePath: 'note.md',
		original: '[missing](missing.png)',
		linkPath: 'missing.png',
		position: position(2, 24),
	};
	assert.deepEqual(findBrokenLinkOffset(`\n\n${link.original}`, link), { start: 2, end: 24 });
	assert.deepEqual(findBrokenLinkOffset(`New\n${link.original}`, link), { start: 4, end: 4 + link.original.length });
	assert.equal(findBrokenLinkOffset('changed only', link), null);
});

test('generates a stable key per source occurrence', () => {
	const base = { sourcePath: 'note.md', original: 'x', linkPath: 'x.png', position: position(2, 8) };
	assert.equal(brokenLinkKey(base), brokenLinkKey({ ...base, original: 'y' }));
	assert.notEqual(brokenLinkKey(base), brokenLinkKey({ ...base, position: position(9, 15) }));
});

test('does not remove an image link after its target is restored', async () => {
	const link = { sourcePath: 'note.md', original: '![missing](image.png)', linkPath: 'image.png', position: position(0, 21) };
	let processed = false;
	const app = {
		metadataCache: { getFirstLinkpathDest: () => ({ path: 'image.png' }) },
		vault: {
			getFileByPath: () => ({ path: 'note.md', extension: 'md' }),
			process: async () => { processed = true; },
		},
	};
	const result = await removeSelectedBrokenLinks(app, [link]);
	assert.deepEqual(result, { removed: 0, skipped: 1, failed: [] });
	assert.equal(processed, false);
});
