import test from 'node:test';
import assert from 'node:assert/strict';
import {
	hasHiddenPathSegment,
	isFrontmatterOnly,
	isPathInFolder,
	joinVaultPath,
	isVaultRelativePath,
	needsRawTextSearch,
	normalizeSettings,
	parseExtensions,
	pathLikeTokens,
	pathTokenCandidates,
	parseIgnoredFolders,
	isIgnoredPath,
} from '../src/core-utils.ts';
import { createMissingNotes, findBrokenNoteLinks, missingNotePath } from '../src/broken-note-links.ts';
import { buildLinkStatsIndex } from '../src/link-stats-core.ts';

test('joins a root target without introducing a leading slash', () => {
	assert.equal(joinVaultPath('', 'Pages'), 'Pages');
});

test('rejects absolute and parent-traversal vault paths', () => {
	assert.equal(isVaultRelativePath('folder/target'), true);
	assert.equal(isVaultRelativePath('/target'), false);
	assert.equal(isVaultRelativePath('C:/target'), false);
	assert.equal(isVaultRelativePath('folder/../target'), false);
	assert.equal(isVaultRelativePath('..\\target'), false);
	assert.equal(isVaultRelativePath('folder\\..\\target'), false);
	assert.equal(isVaultRelativePath('folder/target\0.md'), false);
	assert.equal(isVaultRelativePath('folder//target'), false);
});

test('counts incoming links from outside a single-file refresh set', () => {
	const stats = buildLinkStatsIndex({
		'other.md': { 'target.md': 1 },
	}, new Set(['target.md']), new Set(['other.md', 'target.md']));
	assert.deepEqual(stats.get('target.md'), { incoming: 1, outgoing: 0, bidirectional: 0 });
});

test('ignores non-Markdown sources in the resolved-link cache', () => {
	const stats = buildLinkStatsIndex({ 'canvas': { 'target.md': 1 } }, new Set(['target.md']), new Set(['target.md']));
	assert.deepEqual(stats.get('target.md'), { incoming: 0, outgoing: 0, bidirectional: 0 });
});

test('preserves bidirectional counts when refreshing a subset', () => {
	const stats = buildLinkStatsIndex({
		'one.md': { 'two.md': 1 },
		'two.md': { 'one.md': 1 },
	}, new Set(['one.md']), new Set(['one.md', 'two.md']));
	assert.deepEqual(stats.get('one.md'), { incoming: 1, outgoing: 1, bidirectional: 1 });
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

test('recognizes empty and populated YAML frontmatter as frontmatter-only', () => {
	assert.equal(isFrontmatterOnly('---\n---\n'), true);
	assert.equal(isFrontmatterOnly('---\ntitle: note\n---\n'), true);
	assert.equal(isFrontmatterOnly('---\ntitle: note\n---\n正文\n'), false);
});

test('includes all Markdown files when the selected folder is the vault root', () => {
	assert.equal(isPathInFolder('notes/a.md', ''), true);
	assert.equal(isPathInFolder('notes/a.md', 'notes'), true);
	assert.equal(isPathInFolder('notebook/a.md', 'notes'), false);
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

test('extracts URL-encoded path tokens', () => {
	assert.ok(pathLikeTokens('![photo](assets/my%20photo.png)').includes('assets/my%20photo.png'));
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
	assert.equal(missingNotePath({ sourcePath: 'source.md', linkPath: '.obsidian/plugins/target', original: '[[.obsidian/plugins/target]]', position: { start: { offset: 0 }, end: { offset: 29 } }, syntax: 'wiki' }), null);
	assert.equal(missingNotePath({ sourcePath: 'notes/source.md', linkPath: 'folder/target', original: '[target](folder/target)', position: { start: { offset: 0 }, end: { offset: 23 } }, syntax: 'markdown' }), 'notes/folder/target.md');
	assert.equal(missingNotePath({ sourcePath: 'notes/source.md', linkPath: './target', original: '[target](./target)', position: { start: { offset: 0 }, end: { offset: 18 } }, syntax: 'markdown' }), 'notes/target.md');
	assert.equal(missingNotePath({ sourcePath: 'source.md', linkPath: 'assets/my%20note', original: '[note](assets/my%20note)', position: { start: { offset: 0 }, end: { offset: 24 } }, syntax: 'markdown' }), 'assets/my note.md');
	assert.equal(missingNotePath({ sourcePath: 'source.md', linkPath: 'assets/%2e%2e/target', original: '[[assets/%2e%2e/target]]', position: { start: { offset: 0 }, end: { offset: 25 } }, syntax: 'wiki' }), null);
	assert.equal(missingNotePath({ sourcePath: 'source.md', linkPath: 'assets/%5C..%5Ctarget', original: '[[assets/%5C..%5Ctarget]]', position: { start: { offset: 0 }, end: { offset: 25 } }, syntax: 'wiki' }), null);
});

test('does not classify Markdown image embeds as broken note links', () => {
	const cache = { links: [{ original: '![missing](missing.md)', link: 'missing.md', position: { start: { offset: 0 }, end: { offset: 24 } } }] };
	const app = {
		vault: { getMarkdownFiles: () => [{ path: 'source.md' }] },
		metadataCache: { getFileCache: () => cache, getFirstLinkpathDest: () => null },
	};
	assert.deepEqual(findBrokenNoteLinks(app, 'png'), []);
});

test('does not classify unconfigured image links as broken note links', () => {
	const cache = { links: [{ original: '[photo](missing.jpg)', link: 'missing.jpg', position: { start: { offset: 0 }, end: { offset: 21 } } }] };
	const app = {
		vault: { getMarkdownFiles: () => [{ path: 'source.md' }] },
		metadataCache: { getFileCache: () => cache, getFirstLinkpathDest: () => null },
	};
	assert.deepEqual(findBrokenNoteLinks(app, 'png'), []);
});

test('does not classify common office attachments as broken note links', () => {
	const cache = { links: [{ original: '[sheet](missing.xlsx)', link: 'missing.xlsx', position: { start: { offset: 0 }, end: { offset: 22 } } }] };
	const app = {
		vault: { getMarkdownFiles: () => [{ path: 'source.md' }] },
		metadataCache: { getFileCache: () => cache, getFirstLinkpathDest: () => null },
	};
	assert.deepEqual(findBrokenNoteLinks(app, 'png'), []);
});

test('respects custom image extensions when finding broken note links', () => {
	const cache = { links: [{ original: '[icon](missing.jico)', link: 'missing.jico', position: { start: { offset: 0 }, end: { offset: 21 } } }] };
	const app = {
		vault: { getMarkdownFiles: () => [{ path: 'source.md' }] },
		metadataCache: { getFileCache: () => cache, getFirstLinkpathDest: () => null },
	};
	assert.deepEqual(findBrokenNoteLinks(app, 'png, jico'), []);
});

test('skips case-insensitive existing targets when creating missing notes', async () => {
	const files = [{ path: 'Notes/Target.md' }];
	const created = [];
	const app = {
		vault: {
			getAllLoadedFiles: () => files,
			getAbstractFileByPath: (path) => files.find((file) => file.path === path),
			createFolder: async () => {},
			create: async (path) => { created.push(path); files.push({ path }); },
		},
	};
	const result = await createMissingNotes(app, [{ sourcePath: 'source.md', linkPath: 'notes/target', original: '[[notes/target]]', position: { start: { offset: 0 }, end: { offset: 16 } }, syntax: 'wiki' }]);
	assert.deepEqual(created, []);
	assert.deepEqual(result.skipped, [{ path: 'notes/target.md', reason: '目标已存在' }]);
});

test('does not recreate case-insensitive existing parent folders', async () => {
	const files = [{ path: 'Notes' }];
	const createdFolders = [];
	const app = {
		vault: {
			getAllLoadedFiles: () => files,
			getAbstractFileByPath: (path) => files.find((file) => file.path === path),
			createFolder: async (path) => { createdFolders.push(path); files.push({ path }); },
			create: async (path) => { files.push({ path }); },
		},
	};
	const result = await createMissingNotes(app, [{ sourcePath: 'source.md', linkPath: 'notes/new', original: '[[notes/new]]', position: { start: { offset: 0 }, end: { offset: 14 } }, syntax: 'wiki' }]);
	assert.deepEqual(createdFolders, []);
	assert.deepEqual(result.created, ['notes/new.md']);
});

test('keeps dotted note names eligible for broken note detection', () => {
	const cache = { links: [{ original: '[[API.v2]]', link: 'API.v2', position: { start: { offset: 0 }, end: { offset: 10 } } }] };
	const app = {
		vault: { getMarkdownFiles: () => [{ path: 'source.md' }] },
		metadataCache: { getFileCache: () => cache, getFirstLinkpathDest: () => null },
	};
	assert.equal(findBrokenNoteLinks(app, 'png').length, 1);
});
