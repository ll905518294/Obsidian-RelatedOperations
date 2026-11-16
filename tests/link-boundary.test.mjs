import test from 'node:test';
import assert from 'node:assert/strict';
import { convertWikiNoteLink, findWikiNoteLinks, replaceWikiNoteLinks } from '../src/wiki-note-links.ts';
import { convertNativeImageLink, findNativeImageLinks, replaceNativeImageLinks } from '../src/native-image-links.ts';
import { findBrokenNoteLinks, missingNotePath } from '../src/broken-note-links.ts';
import { findBrokenImageLinks, findBrokenLinkOffset } from '../src/broken-image-links.ts';

const pos = (start, original) => ({ start: { offset: start }, end: { offset: start + original.length } });

const wikiLink = (original, path = 'a.md', extra = {}) => ({
	sourcePath: 'note.md',
	original,
	linkPath: path.replace(/\.md$/, ''),
	position: pos(extra.start ?? 0, original),
	file: Object.hasOwn(extra, 'file') ? extra.file : { path },
	heading: extra.heading,
	blockId: extra.blockId,
	reason: extra.reason,
});

const nativeLink = (original, path, extra = {}) => ({
	sourcePath: 'note.md',
	original,
	linkPath: path,
	position: pos(extra.start ?? 0, original),
	file: Object.hasOwn(extra, 'file') ? extra.file : { path },
	reason: extra.reason,
});

const wikiApp = (cache, resolver = () => ({ path: 'a.md' })) => ({
	vault: { getMarkdownFiles: () => [{ path: 'note.md' }] },
	metadataCache: { getFileCache: () => cache, getFirstLinkpathDest: resolver },
});

// ---------------------------------------------------------------------------
// Wiki note links: link text / destination escaping boundaries
// ---------------------------------------------------------------------------

test('escapes backslashes in the wiki link alias text', () => {
	assert.equal(
		convertWikiNoteLink(wikiLink(String.raw`[[a|前\后]]`)),
		String.raw`[前\\后](<a.md>)`,
	);
});

test('escapes the pipe character in a multi-part wiki alias', () => {
	assert.equal(
		convertWikiNoteLink(wikiLink('[[a|前|后]]')),
		String.raw`[前\|后](<a.md>)`,
	);
});

test('escapes an opening bracket that reaches the link text from a heading', () => {
	assert.equal(
		convertWikiNoteLink(wikiLink('[[a#[x]]', 'a.md', { heading: '[x' })),
		String.raw`[a > \[x](<a.md#[x>)`,
	);
});

test('double-encodes percent sequences in the wiki destination', () => {
	assert.equal(
		convertWikiNoteLink(wikiLink('[[a%20b]]', 'a%20b.md')),
		'[a%20b](<a%2520b.md>)',
	);
	assert.equal(
		convertWikiNoteLink(wikiLink('[[a^b%20c]]', 'a.md', { blockId: 'b%20c' })),
		'[a > ^b%20c](<a.md#^b%2520c>)',
	);
});

test('keeps spaces literal inside the angle-bracket destination', () => {
	assert.equal(
		convertWikiNoteLink(wikiLink('[[a]]', 'folder/我的 笔记.md')),
		'[a](<folder/我的 笔记.md>)',
	);
});

test('keeps nested parentheses literal inside the angle-bracket destination', () => {
	assert.equal(
		convertWikiNoteLink(wikiLink('[[a]]', 'notes/file (1) (2).md')),
		'[a](<notes/file (1) (2).md>)',
	);
});

test('uses the resolved canonical path for a case-variant wiki target', () => {
	assert.equal(convertWikiNoteLink(wikiLink('[[A]]', 'a.md')), '[A](<a.md>)');
});

test('does not convert wiki links inside frontmatter or fenced code', () => {
	const inFrontmatter = {
		links: [{ original: '[[a]]', link: 'a', position: pos(3, '[[a]]') }],
		frontmatterPosition: { start: { offset: 0 }, end: { offset: 20 } },
	};
	assert.equal(findWikiNoteLinks(wikiApp(inFrontmatter)).length, 0);

	const inCode = {
		links: [{ original: '[[a]]', link: 'a', position: pos(10, '[[a]]') }],
		sections: [{ type: 'code', position: { start: { offset: 0 }, end: { offset: 40 } } }],
	};
	assert.equal(findWikiNoteLinks(wikiApp(inCode)).length, 0);
});

// ---------------------------------------------------------------------------
// Native image links: alt text and destination escaping boundaries
// ---------------------------------------------------------------------------

test('escapes backslashes, pipes and brackets in the native alt text', () => {
	assert.equal(
		convertNativeImageLink(nativeLink(String.raw`![[img.png|前\后]]`, 'img.png')),
		String.raw`![前\\后](<img.png>)`,
	);
	assert.equal(
		convertNativeImageLink(nativeLink('![[img.png|前|后]]', 'img.png')),
		String.raw`![前\|后](<img.png>)`,
	);
	assert.equal(
		convertNativeImageLink(nativeLink('![[img.png|a[b]]', 'img.png')),
		String.raw`![a\[b](<img.png>)`,
	);
});

// Markdown destinations are URI-decoded by Obsidian and by this repo's own
// link scans, so a literal `%` or `#` in an image filename must be escaped or
// the link silently points at a different (or truncated) path.
test('escapes percent and hash in the native image destination', () => {
	assert.equal(
		convertNativeImageLink(nativeLink('![[100%.png]]', '100%.png')),
		'![](<100%25.png>)',
	);
	assert.equal(
		convertNativeImageLink(nativeLink('![[img#1.png]]', 'img#1.png')),
		'![](<img%231.png>)',
	);
});

test('keeps spaces and nested parentheses literal in the native destination', () => {
	assert.equal(
		convertNativeImageLink(nativeLink('![[a b.png]]', 'folder/a b.png')),
		'![](<folder/a b.png>)',
	);
	assert.equal(
		convertNativeImageLink(nativeLink('![[file (1) (2).png]]', 'notes/file (1) (2).png')),
		'![](<notes/file (1) (2).png>)',
	);
});

test('uses the resolved canonical path for a case-variant native target', () => {
	assert.equal(convertNativeImageLink(nativeLink('![[IMG.PNG]]', 'img.png')), '![](<img.png>)');
});

test('does not convert native image embeds inside frontmatter or fenced code', () => {
	const inFrontmatter = {
		embeds: [{ original: '![[img.png]]', link: 'img.png', position: pos(3, '![[img.png]]') }],
		frontmatterPosition: { start: { offset: 0 }, end: { offset: 20 } },
	};
	assert.equal(findNativeImageLinks(wikiApp(inFrontmatter, () => ({ path: 'img.png' })), 'png').length, 0);

	const inCode = {
		embeds: [{ original: '![[img.png]]', link: 'img.png', position: pos(10, '![[img.png]]') }],
		sections: [{ type: 'code', position: { start: { offset: 0 }, end: { offset: 40 } } }],
	};
	assert.equal(findNativeImageLinks(wikiApp(inCode, () => ({ path: 'img.png' })), 'png').length, 0);
});

// ---------------------------------------------------------------------------
// Broken note links: missing-path normalization boundaries
// ---------------------------------------------------------------------------

test('missingNotePath decodes percent-encoded names and keeps nested parentheses', () => {
	const base = { sourcePath: 'notes/note.md', original: '', position: pos(0, 'x') };
	assert.equal(missingNotePath({ ...base, linkPath: 'a%20b', syntax: 'wiki' }), 'notes/a b.md');
	assert.equal(missingNotePath({ ...base, linkPath: 'a%20b', syntax: 'markdown' }), 'notes/a b.md');
	assert.equal(missingNotePath({ ...base, linkPath: 'file (1) (2)', syntax: 'wiki' }), 'notes/file (1) (2).md');
	assert.equal(missingNotePath({ ...base, linkPath: 'dir/a', syntax: 'wiki' }), 'dir/a.md');
	assert.equal(missingNotePath({ ...base, linkPath: '../a', syntax: 'wiki' }), null);
});

test('reports a percent-encoded broken note link and ignores code/frontmatter', () => {
	const cache = {
		links: [
			{ original: '[[a%20b]]', link: 'a b', position: pos(0, '[[a%20b]]') },
			{ original: '[[c]]', link: 'c', position: pos(12, '[[c]]') },
		],
		sections: [{ type: 'code', position: { start: { offset: 10 }, end: { offset: 30 } } }],
	};
	const app = { vault: { getMarkdownFiles: () => [{ path: 'note.md' }] }, metadataCache: { getFileCache: () => cache, getFirstLinkpathDest: () => null } };
	const broken = findBrokenNoteLinks(app, 'png');
	assert.equal(broken.length, 1);
	assert.equal(broken[0].linkPath, 'a b');
});

// ---------------------------------------------------------------------------
// Broken image links: percent-encoded paths and offset fallback boundaries
// ---------------------------------------------------------------------------

test('finds percent-encoded and nested-parenthesis broken image links', () => {
	const cache = {
		embeds: [
			{ original: '![[img%20x.png]]', link: 'img%20x.png', position: pos(0, '![[img%20x.png]]') },
			{ original: '![](notes/file (1) (2).png)', link: 'notes/file (1) (2).png', position: pos(20, '![](notes/file (1) (2).png)') },
		],
	};
	const app = { vault: { getMarkdownFiles: () => [{ path: 'note.md' }] }, metadataCache: { getFileCache: () => cache, getFirstLinkpathDest: () => null } };
	const found = findBrokenImageLinks(app, 'png');
	assert.deepEqual(found.map((link) => link.linkPath), ['img%20x.png', 'notes/file (1) (2).png']);
});

test('relocates a percent-encoded broken image link by searching changed content', () => {
	const original = '![[img%20x.png]]';
	const content = `a ${original} b`;
	const link = { sourcePath: 'note.md', original, linkPath: 'img%20x.png', position: pos(99, original) };
	assert.deepEqual(findBrokenLinkOffset(content, link), { start: 2, end: 2 + original.length });
});

// ---------------------------------------------------------------------------
// Same note, multiple references: right-to-left replacement stays exact
// ---------------------------------------------------------------------------

test('converts several wiki references in one note without shifting later offsets', () => {
	const content = '[[a]] and [[a#H]] and [[a^b]]';
	const originals = ['[[a]]', '[[a#H]]', '[[a^b]]'];
	const links = originals.map((original) => wikiLink(original, 'a.md', {
		start: content.indexOf(original),
		heading: original.includes('#') ? 'H' : undefined,
		blockId: original.includes('^') ? 'b' : undefined,
	}));
	const result = replaceWikiNoteLinks(content, links);
	assert.equal(result.converted, 3);
	assert.equal(result.skipped, 0);
	assert.equal(result.content, '[a](<a.md>) and [a > H](<a.md#H>) and [a > ^b](<a.md#^b>)');
});

test('converts several native embeds in one note without shifting later offsets', () => {
	const content = '![[a.png]] and ![[b.png]]';
	const links = ['![[a.png]]', '![[b.png]]'].map((original) => nativeLink(original, original.slice(3, -2), { start: content.indexOf(original) }));
	const result = replaceNativeImageLinks(content, links);
	assert.equal(result.converted, 2);
	assert.equal(result.skipped, 0);
	assert.equal(result.content, '![](<a.png>) and ![](<b.png>)');
});
