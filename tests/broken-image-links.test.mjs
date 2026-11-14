import test from 'node:test';
import assert from 'node:assert/strict';
import {
	brokenLinkKey,
	findBrokenLinkOffset,
	findBrokenImageLinks,
	removeBrokenImageLinks,
	removeSelectedBrokenLinks,
} from '../src/broken-image-links.ts';
import { removeCachedLinkRanges } from '../src/core-utils.ts';

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

test('removes multiple links that share one line from right to left', () => {
	const first = '![a](broken(a).png)';
	const second = '![b](other.png)';
	const content = `${first} ${second}\nAfter`;
	const links = [
		{ sourcePath: 'note.md', original: first, linkPath: 'broken(a).png', position: position(0, first.length) },
		{ sourcePath: 'note.md', original: second, linkPath: 'other.png', position: position(first.length + 1, first.length + 1 + second.length) },
	];
	const result = removeBrokenImageLinks(content, links);
	// Removing the right link first empties the shared line, so the left link is
	// then deleted as whole-line removal — both rows collapse to a single break.
	assert.equal(result.content, 'After');
	assert.deepEqual({ removed: result.removed, skipped: result.skipped }, { removed: 2, skipped: 0 });
});

test('removes a link whose path contains nested parentheses alone on a line', () => {
	const original = '![x](broken(a).png)';
	const content = `Intro\n${original}\nOutro`;
	const link = { sourcePath: 'note.md', original, linkPath: 'broken(a).png', position: position(content.indexOf(original), content.indexOf(original) + original.length) };
	const result = removeBrokenImageLinks(content, [link]);
	assert.equal(result.content, 'Intro\nOutro');
	assert.deepEqual({ removed: result.removed, skipped: result.skipped }, { removed: 1, skipped: 0 });
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

test('findBrokenLinkOffset does not return a stale shifted match for the bang wrapper', () => {
	const link = { sourcePath: 'note.md', original: '[[a.png]]', linkPath: 'a.png', position: position(5, 16) };
	assert.equal(findBrokenLinkOffset('![[a.png]]', link), null);
});

test('findBrokenLinkOffset refuses to guess between repeated identical links', () => {
	const original = '![x](m.png)';
	const shifted = `Z${original} and ${original}`;
	const secondStart = shifted.lastIndexOf(original);
	// Cached offset from before the prepend no longer matches the note content.
	const stale = { sourcePath: 'note.md', original, linkPath: 'm.png', position: position(secondStart - 1, secondStart - 1 + original.length) };
	assert.equal(findBrokenLinkOffset(shifted, stale), null);
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

test('reports how many image links failed when the source note is missing', async () => {
	const original = '![x](m.png)';
	const link = (offset) => ({ sourcePath: 'gone.md', original, linkPath: 'm.png', position: position(offset, offset + original.length) });
	const result = await removeSelectedBrokenLinks({
		metadataCache: { getFirstLinkpathDest: () => null },
		vault: { getFileByPath: () => null },
	}, [link(0), link(20)]);
	assert.equal(result.failed.length, 1);
	assert.ok(result.failed[0].reason.includes('2 条链接'), result.failed[0].reason);
	assert.ok(result.failed[0].reason.includes('源笔记不存在'));
});

test('reports the image link count when writing a note throws', async () => {
	const original = '![x](m.png)';
	const result = await removeSelectedBrokenLinks({
		metadataCache: { getFirstLinkpathDest: () => null },
		vault: {
			getFileByPath: () => ({ path: 'note.md', extension: 'md' }),
			process: async () => { throw new Error('readonly'); },
		},
	}, [{ sourcePath: 'note.md', original, linkPath: 'm.png', position: position(0, original.length) }]);
	assert.equal(result.failed.length, 1);
	assert.ok(result.failed[0].reason.includes('1 条链接'), result.failed[0].reason);
	assert.ok(result.failed[0].reason.includes('readonly'));
});

test('keeps successful removals and reports only the failing source in a partial batch', async () => {
	const original = '![x](m.png)';
	let okContent = original;
	const files = { 'ok.md': { path: 'ok.md', extension: 'md' }, 'bad.md': { path: 'bad.md', extension: 'md' } };
	const result = await removeSelectedBrokenLinks({
		metadataCache: { getFirstLinkpathDest: () => null },
		vault: {
			getFileByPath: (path) => files[path] ?? null,
			process: async (file, callback) => {
				if (file.path === 'bad.md') throw new Error('locked');
				okContent = callback(okContent);
			},
		},
	}, [
		{ sourcePath: 'ok.md', original, linkPath: 'm.png', position: position(0, original.length) },
		{ sourcePath: 'bad.md', original, linkPath: 'm.png', position: position(0, original.length) },
	]);
	assert.equal(result.removed, 1);
	assert.equal(okContent, '');
	assert.equal(result.failed.length, 1);
	assert.equal(result.failed[0].path, 'bad.md');
});

test('scans and removes every link in a 5MB note with 5000 links', () => {
	const count = 5000;
	const filler = 'x'.repeat(Math.floor((5 * 1024 * 1024) / count));
	const parts = [];
	const expected = [];
	const links = [];
	let offset = 0;
	for (let i = 0; i < count; i++) {
		const fillerLine = `${filler}\n`;
		parts.push(fillerLine);
		expected.push(fillerLine);
		offset += fillerLine.length;
		const original = `![img](big-miss-${i}.png)`;
		links.push({
			sourcePath: 'huge.md',
			original,
			linkPath: `big-miss-${i}.png`,
			position: position(offset, offset + original.length),
		});
		parts.push(original, '\n');
		offset += original.length + 1;
	}
	const content = parts.join('');
	const cache = { embeds: links.map(({ original, linkPath, position }) => ({ original, link: linkPath, position })) };
	const app = {
		vault: { getMarkdownFiles: () => [{ path: 'huge.md' }] },
		metadataCache: { getFileCache: () => cache, getFirstLinkpathDest: () => null },
	};
	const found = findBrokenImageLinks(app, 'png');
	assert.equal(found.length, count);
	assert.deepEqual(found.map((link) => link.position.start.offset), links.map((link) => link.position.start.offset));

	const started = performance.now();
	const result = removeBrokenImageLinks(content, found);
	const elapsed = performance.now() - started;
	assert.deepEqual({ removed: result.removed, skipped: result.skipped }, { removed: count, skipped: 0 });
	assert.equal(result.content, expected.join(''));
	// A quadratic rewrite of the note took seconds; this guards the per-line path.
	assert.ok(elapsed < 2000, `removal took ${Math.round(elapsed)}ms`);
});

test('removes links past the indexed-line limit through the scanning resolver', () => {
	const emptyLines = 200_001;
	const first = '![[m1.png]]';
	const second = '[[m2.png]]';
	const secondStart = emptyLines + first.length + 1;
	const content = `${'\n'.repeat(emptyLines)}${first}\n${second}\n`;
	const result = removeCachedLinkRanges(content, [
		{ original: first, position: position(emptyLines, emptyLines + first.length) },
		{ original: second, position: position(secondStart, secondStart + second.length) },
	], (actual, original) => actual === original);
	assert.deepEqual({ removed: result.removed, skipped: result.skipped }, { removed: 2, skipped: 0 });
	assert.equal(result.content, '\n'.repeat(emptyLines));
});
