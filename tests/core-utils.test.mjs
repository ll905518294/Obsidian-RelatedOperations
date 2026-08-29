import test from 'node:test';
import assert from 'node:assert/strict';
import {
	hasHiddenPathSegment,
	joinVaultPath,
	needsRawTextSearch,
	normalizeSettings,
	parseExtensions,
	pathLikeTokens,
	pathTokenCandidates,
	parseIgnoredFolders,
	isIgnoredPath,
} from '../src/core-utils.ts';
import { findBrokenNoteLinks, missingNotePath } from '../src/broken-note-links.ts';

test('joins a root target without introducing a leading slash', () => {
	assert.equal(joinVaultPath('', 'Pages'), 'Pages');
});

test('keeps only persisted settings with the expected primitive type', () => {
	const defaults = { enabled: false, autoUpdate: true, orphanImageExtensions: 'png' };
	assert.deepEqual(normalizeSettings(defaults, { enabled: true, autoUpdate: 'yes', orphanImageExtensions: 1 }), {
		enabled: true,
		autoUpdate: true,
		orphanImageExtensions: 'png',
	});
});

test('falls back when a validated setting is invalid', () => {
	const defaults = { incomingProperty: 'in', outgoingProperty: 'out' };
	const valid = (value) => typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value);
	assert.deepEqual(normalizeSettings(defaults, { incomingProperty: 'bad\nname', outgoingProperty: 'ok' }, { incomingProperty: valid }), {
		incomingProperty: 'in',
		outgoingProperty: 'ok',
	});
});

test('detects hidden path segments in any position', () => {
	assert.equal(hasHiddenPathSegment('.obsidian/plugins/demo'), true);
	assert.equal(hasHiddenPathSegment('notes/.trash'), true);
	assert.equal(hasHiddenPathSegment('notes/demo.md'), false);
	assert.equal(hasHiddenPathSegment(''), false);
});

test('extracts path-like tokens including spaced names', () => {
	const content = [
		'---',
		'banner: "assets/banner photo.jpg"',
		'---',
		'<img src="images/pic.PNG">',
		'See note.png.',
	].join('\n');
	const tokens = pathLikeTokens(content);
	assert.ok(tokens.includes('assets/banner photo.jpg'));
	assert.ok(tokens.includes('images/pic.png'));
	const candidates = tokens.flatMap((token) => pathTokenCandidates(token));
	assert.ok(candidates.includes('note.png'));
});

test('parses configurable extensions without case or leading dots', () => {
	assert.deepEqual([...parseExtensions('PNG, .jpg JICO')].sort(), ['jico', 'jpg', 'png']);
});

test('normalizes ignored folders and matches descendants only', () => {
	assert.deepEqual(parseIgnoredFolders(' /assets/，archive\\old\n assets '), ['assets', 'archive/old']);
	assert.equal(isIgnoredPath('assets/photo.png', ['assets']), true);
	assert.equal(isIgnoredPath('assets2/photo.png', ['assets']), false);
});

test('recovers the file name from prose prefixes and folder paths', () => {
	const candidates = pathTokenCandidates('see note.png');
	assert.deepEqual(candidates, ['see note.png', 'note.png']);
	const folderCandidates = pathTokenCandidates('assets/my photo.png');
	assert.deepEqual(folderCandidates, ['assets/my photo.png', 'photo.png']);
	const first = folderCandidates[0];
	assert.equal(first.slice(Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\')) + 1), 'my photo.png');
});

test('flags basenames outside the token alphabet for raw text search', () => {
	assert.equal(needsRawTextSearch('photo (1).png'), true);
	assert.equal(needsRawTextSearch('封面 图.png'), false);
	assert.equal(needsRawTextSearch('cover.jpg'), false);
});

test('resolves missing note paths relative to the source note', () => {
	assert.equal(missingNotePath({ sourcePath: 'notes/source.md', linkPath: 'target', original: '[[target]]', position: { start: { offset: 0 }, end: { offset: 10 } }, syntax: 'wiki' }), 'notes/target.md');
	assert.equal(missingNotePath({ sourcePath: 'source.md', linkPath: 'folder/target.md', original: '[x](folder/target.md)', position: { start: { offset: 0 }, end: { offset: 20 } }, syntax: 'markdown' }), 'folder/target.md');
	assert.equal(missingNotePath({ sourcePath: 'source.md', linkPath: '../target', original: '[[../target]]', position: { start: { offset: 0 }, end: { offset: 13 } }, syntax: 'wiki' }), null);
	assert.equal(missingNotePath({ sourcePath: 'source.md', linkPath: 'folder//target', original: '[[folder//target]]', position: { start: { offset: 0 }, end: { offset: 18 } }, syntax: 'wiki' }), null);
	assert.equal(missingNotePath({ sourcePath: 'source.md', linkPath: 'folder/', original: '[[folder/]]', position: { start: { offset: 0 }, end: { offset: 11 } }, syntax: 'wiki' }), null);
	assert.equal(missingNotePath({ sourcePath: 'source.md', linkPath: 'C:\\target', original: '[[C:\\target]]', position: { start: { offset: 0 }, end: { offset: 14 } }, syntax: 'wiki' }), null);
	assert.equal(missingNotePath({ sourcePath: 'notes/source.md', linkPath: 'folder/target', original: '[target](folder/target)', position: { start: { offset: 0 }, end: { offset: 23 } }, syntax: 'markdown' }), 'notes/folder/target.md');
	assert.equal(missingNotePath({ sourcePath: 'notes/source.md', linkPath: './target', original: '[target](./target)', position: { start: { offset: 0 }, end: { offset: 18 } }, syntax: 'markdown' }), 'notes/target.md');
});

test('does not classify Markdown image embeds as broken note links', () => {
	const cache = { links: [{ original: '![missing](missing.md)', link: 'missing.md', position: { start: { offset: 0 }, end: { offset: 24 } } }] };
	const app = {
		vault: { getMarkdownFiles: () => [{ path: 'source.md' }] },
		metadataCache: { getFileCache: () => cache, getFirstLinkpathDest: () => null },
	};
	assert.deepEqual(findBrokenNoteLinks(app, 'png'), []);
});
