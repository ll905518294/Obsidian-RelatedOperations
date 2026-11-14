import test from 'node:test';
import assert from 'node:assert/strict';
import { createMissingNotes, findBrokenNoteLinks, missingNotePath, removeBrokenNoteLinks, removeSelectedBrokenNoteLinks } from '../src/broken-note-links.ts';

const link = {
	sourcePath: 'note.md',
	original: '[[missing]]',
	linkPath: 'missing',
	position: { start: { offset: 0 }, end: { offset: 11 } },
	syntax: 'wiki',
};

test('does not create a note when the selected broken link was removed after scanning', async () => {
	let created = false;
	const app = {
		metadataCache: { getFirstLinkpathDest: () => null },
		vault: {
			getAllLoadedFiles: () => [{ path: 'note.md' }],
			getFileByPath: () => ({ path: 'note.md', extension: 'md' }),
			read: async () => 'changed',
			create: async () => { created = true; },
		},
	};
	const result = await createMissingNotes(app, [link]);
	assert.deepEqual(result, { created: [], skipped: [{ path: 'missing.md', reason: '链接已变化或目标已恢复' }], failed: [] });
	assert.equal(created, false);
});

test('rejects Windows drive-relative paths from missing note creation', () => {
	const drive = { sourcePath: 'note.md', linkPath: 'C:target', original: '[[C:target]]', position: { start: { offset: 0 }, end: { offset: 11 } }, syntax: 'wiki' };
	assert.equal(missingNotePath(drive), null);
});

test('removes multiple wiki links sharing one line and nested anchors', () => {
	const link = (offset) => {
		const original = '[[missing]]';
		return { sourcePath: 'note.md', original, linkPath: 'missing', position: { start: { offset }, end: { offset: offset + original.length } }, syntax: 'wiki' };
	};
	const content = '[[missing]] and [[missing]] and after';
	const target = '[[missing]]';
	const a = content.indexOf(target);
	const b = content.indexOf(target, a + target.length);
	const l1 = { ...link(a), position: { start: { offset: a }, end: { offset: a + target.length } } };
	const l2 = { ...link(b), position: { start: { offset: b }, end: { offset: b + target.length } } };
	const result = removeBrokenNoteLinks(content, [l1, l2]);
	assert.equal(result.content, ' and  and after');
	assert.equal(result.removed, 2);
	assert.equal(result.skipped, 0);
});

test('reports how many note links failed when the source note is missing', async () => {
	const original = '[[missing]]';
	const link = (offset) => ({ sourcePath: 'gone.md', original, linkPath: 'missing', position: { start: { offset }, end: { offset: offset + original.length } }, syntax: 'wiki' });
	const result = await removeSelectedBrokenNoteLinks({
		metadataCache: { getFirstLinkpathDest: () => null },
		vault: { getFileByPath: () => null },
	}, [link(0), link(15)]);
	assert.equal(result.failed.length, 1);
	assert.ok(result.failed[0].reason.includes('2 条链接'), result.failed[0].reason);
	assert.ok(result.failed[0].reason.includes('源笔记不存在'));
});

test('reports a failed create when writing the note throws', async () => {
	const link = { sourcePath: 'note.md', original: '[[missing]]', linkPath: 'missing', position: { start: { offset: 0 }, end: { offset: 11 } }, syntax: 'wiki' };
	const result = await createMissingNotes({
		metadataCache: { getFirstLinkpathDest: () => null },
		vault: {
			getAllLoadedFiles: () => [{ path: 'note.md' }],
			getFileByPath: () => ({ path: 'note.md', extension: 'md' }),
			read: async () => '[[missing]]',
			createFolder: async () => {},
			create: async () => { throw new Error('disk full'); },
		},
	}, [link]);
	assert.equal(result.failed.length, 1);
	assert.ok(result.failed[0].reason.includes('disk full'));
});

// A root-level target has no parent directory. The old slice(0, -1) fallback
// created a folder named after the file minus its last character (e.g.
// `missing.m` for `missing.md`).
test('does not create a folder for a root-level missing note', async () => {
	const source = { path: 'note.md', extension: 'md' };
	const folders = [];
	const result = await createMissingNotes({
		metadataCache: { getFirstLinkpathDest: () => null },
		vault: {
			getAllLoadedFiles: () => [source],
			getFileByPath: (path) => (path === source.path ? source : null),
			read: async () => '[[missing]]',
			createFolder: async (path) => { folders.push(path); },
			create: async () => {},
		},
	}, [{ ...link, position: { start: { offset: 0 }, end: { offset: '[[missing]]'.length } } }]);
	assert.deepEqual(result.created, ['missing.md']);
	assert.deepEqual(result.failed, []);
	assert.deepEqual(folders, []);
});

test('removes thousands of note links from a large note', () => {
	const count = 2000;
	const filler = 'y'.repeat(Math.floor((1024 * 1024) / count));
	const parts = [];
	const expected = [];
	const links = [];
	let offset = 0;
	for (let i = 0; i < count; i++) {
		const fillerLine = `${filler}\n`;
		parts.push(fillerLine);
		expected.push(fillerLine);
		offset += fillerLine.length;
		const original = `[[missing-${i}]]`;
		links.push({
			sourcePath: 'huge.md',
			original,
			linkPath: `missing-${i}`,
			syntax: 'wiki',
			position: { start: { offset }, end: { offset: offset + original.length } },
		});
		parts.push(original, '\n');
		offset += original.length + 1;
	}
	const result = removeBrokenNoteLinks(parts.join(''), links);
	assert.deepEqual({ removed: result.removed, skipped: result.skipped }, { removed: count, skipped: 0 });
	assert.equal(result.content, expected.join(''));
});

// Canvas files are non-Markdown targets in this plugin's model (README treats
// them separately from notes/attachments). A missing `[[board.canvas]]` must
// not be offered as a "missing note", otherwise creating it writes
// `board.canvas.md`.
test('does not treat a missing Canvas link as a broken note link', () => {
	const original = '[[board.canvas]]';
	const cache = {
		links: [{ original, link: 'board.canvas', position: { start: { offset: 0 }, end: { offset: original.length } } }],
	};
	const app = {
		vault: { getMarkdownFiles: () => [{ path: 'note.md' }] },
		metadataCache: { getFileCache: () => cache, getFirstLinkpathDest: () => null },
	};
	assert.deepEqual(findBrokenNoteLinks(app, 'png'), []);
});

// Creating N missing notes from links in one note must read that note once,
// not once per link (a 2000-link note would otherwise be parsed 2000 times).
test('reads each source note once when creating multiple missing notes', async () => {
	const source = { path: 'note.md', extension: 'md' };
	let content = '';
	const links = [];
	for (let i = 0; i < 20; i++) {
		const original = `[[missing-${i}]]`;
		links.push({
			sourcePath: source.path,
			original,
			linkPath: `missing-${i}`,
			position: { start: { offset: content.length }, end: { offset: content.length + original.length } },
			syntax: 'wiki',
		});
		content += `${original}\n`;
	}
	let reads = 0;
	const app = {
		metadataCache: { getFirstLinkpathDest: () => null },
		vault: {
			getAllLoadedFiles: () => [source],
			getFileByPath: (path) => (path === source.path ? source : null),
			read: async () => { reads++; return content; },
			create: async () => {},
		},
	};
	const result = await createMissingNotes(app, links);
	assert.equal(result.created.length, 20, JSON.stringify(result));
	assert.equal(reads, 1);
});

// Path existence is checked for every target and every parent segment. Scanning
// the whole loaded-file list each time makes bulk creation O(targets × files);
// a single snapshot for the batch is enough.
test('scans loaded files once when creating many missing notes', async () => {
	const sources = Array.from({ length: 30 }, (_, i) => ({ path: `s/${i}.md`, extension: 'md' }));
	const byPath = new Map(sources.map((file, i) => [file.path, { ...file, content: `[[missing-${i}]]` }]));
	const links = sources.map((source, i) => ({
		sourcePath: source.path,
		original: `[[missing-${i}]]`,
		linkPath: `missing-${i}`,
		position: { start: { offset: 0 }, end: { offset: `[[missing-${i}]]`.length } },
		syntax: 'wiki',
	}));
	let scans = 0;
	const app = {
		metadataCache: { getFirstLinkpathDest: () => null },
		vault: {
			getAllLoadedFiles: () => { scans++; return [...byPath.values()]; },
			getFileByPath: (path) => byPath.get(path) ?? null,
			read: async (file) => byPath.get(file.path).content,
			createFolder: async () => {},
			create: async () => {},
		},
	};
	const result = await createMissingNotes(app, links);
	assert.equal(result.created.length, 30, JSON.stringify(result));
	assert.equal(scans, 1);
});
