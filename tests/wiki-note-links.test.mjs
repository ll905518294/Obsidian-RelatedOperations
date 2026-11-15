import test from 'node:test';
import assert from 'node:assert/strict';
import { convertWikiNoteLink, findWikiNoteLinks, replaceWikiNoteLinks, revalidateWikiNoteLink, wikiNoteLinkKey, wikiNoteLinkOffset } from '../src/wiki-note-links.ts';
import { findBrokenNoteLinks } from '../src/broken-note-links.ts';

const link = (original, path = 'a.md', start = 0, extra = {}) => ({
	sourcePath: 'note.md',
	original,
	linkPath: path.replace(/\.md$/, ''),
	position: { start: { offset: start }, end: { offset: start + original.length } },
	file: Object.hasOwn(extra, 'file') ? extra.file : { path },
	heading: extra.heading,
	blockId: extra.blockId,
	reason: extra.reason,
});

test('converts basic, aliased, heading and block-id wiki links to markdown', () => {
	assert.equal(convertWikiNoteLink(link('[[a]]')), '[a](<a.md>)');
	assert.equal(convertWikiNoteLink(link('[[a|别名]]')), '[别名](<a.md>)');
	assert.equal(convertWikiNoteLink(link('[[a#标题]]', 'a.md', 0, { heading: '标题' })), '[a > 标题](<a.md#标题>)');
	assert.equal(convertWikiNoteLink(link('[[a#标题|别名]]', 'a.md', 0, { heading: '标题' })), '[别名](<a.md#标题>)');
	assert.equal(convertWikiNoteLink(link('[[a^块id]]', 'a.md', 0, { blockId: '块id' })), '[a > ^块id](<a.md#^块id>)');
});

test('uses the resolved target path in the markdown URL', () => {
	const resolved = link('[[a]]', 'folder/a（示例）.md');
	assert.equal(convertWikiNoteLink(resolved), '[a](<folder/a（示例）.md>)');
});

test('returns null for unresolved targets and skipped conversions', () => {
	assert.equal(convertWikiNoteLink(link('[[a]]', '', 0, { file: undefined })), null);
	assert.equal(convertWikiNoteLink(link('[[a]]', 'a.md', 0, { reason: '已经转过了' })), null);
});

const app = (cache, resolver) => ({
	vault: { getMarkdownFiles: () => [{ path: 'note.md' }] },
	metadataCache: {
		getFileCache: () => cache,
		getFirstLinkpathDest: resolver ?? (() => ({ path: 'a.md' })),
	},
});
const cacheOf = (original) => ({ links: [{ original, link: 'a', position: { start: { offset: 0 }, end: { offset: original.length } } }] });

test('finds a plain wiki link and targets the resolved .md file', () => {
	const found = findWikiNoteLinks(app(cacheOf('[[a]]')));
	assert.equal(found.length, 1);
	assert.equal(found[0].linkPath, 'a');
	assert.equal(found[0].file.path, 'a.md');
});

test('skips embeds, markdown links, external URLs and non-md targets', () => {
	const nonMd = (path) => (parsed, source) => (parsed === 'photo.png' || parsed === 'board.canvas' ? { path } : { path: 'a.md' });
	assert.equal(findWikiNoteLinks(app(cacheOf('![[a]]'))).length, 0, 'image embed must be skipped');
	assert.equal(findWikiNoteLinks(app(cacheOf('[text](a.md)'))).length, 0, 'markdown link must be skipped');
	assert.equal(findWikiNoteLinks(app(cacheOf('[[https://example.com/a]]'))).length, 0, 'external URL must be skipped');
	assert.equal(findWikiNoteLinks(app(cacheOf('[[photo.png]]'), nonMd('photo.png'))).length, 0, 'image target must be skipped');
	assert.equal(findWikiNoteLinks(app(cacheOf('[[board.canvas]]'), nonMd('board.canvas'))).length, 0, 'canvas target must be skipped');
});

test('skips links inside fenced code blocks and frontmatter', () => {
	const original = '[[a]]';
	const codeCache = {
		links: [{ original, link: 'a', position: { start: { offset: 10 }, end: { offset: 10 + original.length } } }],
		sections: [{ type: 'code', position: { start: { offset: 0 }, end: { offset: 30 } } }],
	};
	assert.equal(findWikiNoteLinks(app(codeCache)).length, 0, 'code block link must be skipped');
	const fmCache = {
		links: [{ original, link: 'a', position: { start: { offset: 3 }, end: { offset: 3 + original.length } } }],
		frontmatterPosition: { start: { offset: 0 }, end: { offset: 20 } },
	};
	assert.equal(findWikiNoteLinks(app(fmCache)).length, 0, 'frontmatter link must be skipped');
});

test('omits links whose target cannot be resolved', () => {
	const found = findWikiNoteLinks(app(cacheOf('[[missing]]'), () => null));
	assert.equal(found.length, 0);
});

test('replaces multiple links right-to-left and converts each once', () => {
	const content = '[[a]] and [[a]] and after';
	const a = content.indexOf('[[a]]');
	const b = content.indexOf('[[a]]', a + '[[a]]'.length);
	const links = [
		link('[[a]]', 'a.md', a),
		link('[[a]]', 'a.md', b),
	];
	const result = replaceWikiNoteLinks(content, links);
	assert.equal(result.converted, 2);
	assert.equal(result.skipped, 0);
	assert.equal(result.content, '[a](<a.md>) and [a](<a.md>) and after');
});

test('skips duplicate and out-of-bounds positions without converting', () => {
	const content = '[[a]]';
	const dupes = [link('[[a]]', 'a.md', 0), link('[[a]]', 'a.md', 0)];
	assert.equal(replaceWikiNoteLinks(content, dupes).converted, 1);
	assert.equal(replaceWikiNoteLinks(content, dupes).skipped, 1);
	const outOfBounds = link('[[a]]', 'a.md', 10);
	assert.equal(replaceWikiNoteLinks(content, [outOfBounds]).converted, 0);
	assert.equal(replaceWikiNoteLinks(content, [outOfBounds]).skipped, 1);
});

test('skips a link whose content no longer matches the recorded span', () => {
	const result = replaceWikiNoteLinks('same [[a]]', [link('[[a]]', 'a.md', 0)]);
	assert.equal(result.converted, 0);
	assert.equal(result.skipped, 1);
	assert.equal(result.content, 'same [[a]]');
});

test('wikiNoteLinkOffset matches exact position and falls back to search', () => {
	const content = 'before [[a]] after';
	const at = content.indexOf('[[a]]');
	const end = at + '[[a]]'.length;
	assert.deepEqual(wikiNoteLinkOffset(content, link('[[a]]', 'a.md', at)), { start: at, end });
	assert.deepEqual(wikiNoteLinkOffset(content, link('[[a]]', 'a.md', 999)), { start: at, end });
	assert.equal(wikiNoteLinkOffset(content, link('[[a]]', 'a.md', 999), false), null);
});

test('wikiNoteLinkKey is unique per source and position', () => {
	const l1 = link('[[a]]', 'a.md', 0);
	const l2 = link('[[a]]', 'a.md', 8);
	assert.notEqual(wikiNoteLinkKey(l1), wikiNoteLinkKey(l2));
	assert.equal(revalidateWikiNoteLink({ metadataCache: { getFirstLinkpathDest: () => ({ path: 'b.md' }) } }, link('[[a]]')).file.path, 'b.md');
});

// A raw `%` in a destination is a percent-escape to every consumer that
// decodes markdown links (this repo decodes in broken-note-links and the scan
// path reader). A heading such as `100%（完成）` must round-trip, so `%` is
// escaped; `#` would end the fragment and `<`/`>` would end `<...>`.
test('escapes percent, hash and angle brackets in heading, block id and path', () => {
	assert.equal(
		convertWikiNoteLink(link('[[a#100%（完成）]]', 'a.md', 0, { heading: '100%（完成）' })),
		'[a > 100%（完成）](<a.md#100%25（完成）>)',
	);
	assert.equal(
		convertWikiNoteLink(link('[[a#C# 教程]]', 'a.md', 0, { heading: 'C# 教程' })),
		'[a > C# 教程](<a.md#C%23 教程>)',
	);
	assert.equal(
		convertWikiNoteLink(link('[[a#a<b>c]]', 'a.md', 0, { heading: 'a<b>c' })),
		'[a > a<b>c](<a.md#a%3Cb%3Ec>)',
	);
	assert.equal(convertWikiNoteLink(link('[[100%]]', '100%.md')), '[100%](<100%25.md>)');
});

test('keeps spaces, slashes and Chinese literal in the destination', () => {
	assert.equal(
		convertWikiNoteLink(link('[[a#第 1/2 章]]', 'a.md', 0, { heading: '第 1/2 章' })),
		'[a > 第 1/2 章](<a.md#第 1/2 章>)',
	);
});

// Relative wiki paths are resolved by Obsidian; conversion must emit the real
// vault path so `../` note-vs-folder ambiguity cannot reappear later.
test('relative wiki paths convert to the resolved absolute vault path', () => {
	const app = {
		vault: { getMarkdownFiles: () => [{ path: 'sub/note.md' }] },
		metadataCache: {
			getFileCache: () => ({ links: [{ original: '[[../dir/a]]', link: '../dir/a', position: { start: { offset: 0 }, end: { offset: 12 } } }] }),
			getFirstLinkpathDest: (parsed) => (parsed === '../dir/a' ? { path: 'dir/a.md' } : null),
		},
	};
	const [found] = findWikiNoteLinks(app);
	assert.equal(found.file.path, 'dir/a.md');
	assert.equal(convertWikiNoteLink(found), '[../dir/a](<dir/a.md>)');
	const plain = link('[[dir/a]]', 'dir/a.md');
	assert.equal(convertWikiNoteLink(plain), '[dir/a](<dir/a.md>)');
});

test('converts several references to the same target without shifting offsets', () => {
	const content = '[[a]] | [[a#H|别名]] | [[a^b]]';
	const specs = [
		['[[a]]', 'a.md', {}],
		['[[a#H|别名]]', 'a.md', { heading: 'H' }],
		['[[a^b]]', 'a.md', { blockId: 'b' }],
	];
	const links = specs.map(([original, path, extra]) => link(original, path, content.indexOf(original), extra));
	const result = replaceWikiNoteLinks(content, links);
	assert.equal(result.converted, 3);
	assert.equal(result.skipped, 0);
	assert.equal(result.content, '[a](<a.md>) | [别名](<a.md#H>) | [a > ^b](<a.md#^b>)');
});

// Idempotency: markdown links produced by the conversion must never be offered
// as wiki candidates again on a rescan.
test('already converted markdown links are not candidates again', () => {
	const cache = {
		links: [
			{ original: '[[a]]', link: 'a', position: { start: { offset: 0 }, end: { offset: 5 } } },
			{ original: '[a](<a.md>)', link: 'a.md', position: { start: { offset: 10 }, end: { offset: 23 } } },
		],
	};
	const found = findWikiNoteLinks(app(cache));
	assert.equal(found.length, 1);
	assert.equal(found[0].original, '[[a]]');
});

// After conversion the link is markdown syntax. When its target disappears the
// broken-note-links scan must report it (path split at `#`, fragment ignored).
test('converted markdown link is reported as broken once the target is removed', () => {
	const cache = {
		links: [
			{ original: '[a > 标题](<a.md#标题>)', link: 'a.md#标题', position: { start: { offset: 0 }, end: { offset: 23 } } },
		],
	};
	const broken = findBrokenNoteLinks(
		{ vault: { getMarkdownFiles: () => [{ path: 'note.md' }] }, metadataCache: { getFileCache: () => cache, getFirstLinkpathDest: () => null } },
		'png',
	);
	assert.equal(broken.length, 1);
	assert.equal(broken[0].linkPath, 'a.md');
	assert.equal(broken[0].syntax, 'markdown');
});
