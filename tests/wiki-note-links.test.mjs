import test from 'node:test';
import assert from 'node:assert/strict';
import { convertWikiNoteLink, findWikiNoteLinks, replaceWikiNoteLinks, revalidateWikiNoteLink, wikiNoteLinkKey, wikiNoteLinkOffset } from '../src/wiki-note-links.ts';

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
