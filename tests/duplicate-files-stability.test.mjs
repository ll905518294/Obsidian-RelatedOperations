import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicateFiles, planDuplicateDeletion, removeFileReferencesForFiles } from '../src/duplicate-files.ts';

const encoder = new TextEncoder();

function fileOf(path, content) {
	return { path, extension: path.split('.').at(-1).toLowerCase(), stat: { size: content.length, mtime: 1 } };
}

function mutableApp(files, contents) {
	const vault = new Map(files.map((file) => [file.path, file]));
	return {
		vault: {
			getFiles: () => [...vault.values()],
			getAbstractFileByPath: (path) => vault.get(path) ?? null,
			readBinary: async (file) => {
				if (vault.get(file.path) !== file) throw new Error('文件已不存在');
				return encoder.encode(contents[file.path]).buffer;
			},
		},
		metadataCache: { resolvedLinks: {} },
		remove: (path) => vault.delete(path),
	};
}

function noteApp(notes) {
	const contents = new Map(notes.map((note) => [note.path, note.content]));
	const processed = [];
	const resolve = (link) => {
		const clean = link.split('#', 1)[0];
		return notes.find((note) => note.path === clean || note.path === `${clean}.md`) ?? null;
	};
	for (const note of notes) note.extension = 'md';
	return {
		processed,
		contents,
		app: {
			vault: {
				getMarkdownFiles: () => notes,
				getAbstractFileByPath: (path) => notes.find((note) => note.path === path) ?? null,
				readBinary: async (note) => encoder.encode(contents.get(note.path)).buffer,
				process: async (note, change) => {
					processed.push(note.path);
					const next = change(contents.get(note.path));
					contents.set(note.path, next);
					return next;
				},
			},
			metadataCache: {
				getFileCache: (note) => ({ links: note.links ?? [], embeds: note.embeds ?? [] }),
				resolvedLinks: Object.fromEntries(notes.map((note) => [note.path, note.resolved ?? {}])),
				getFirstLinkpathDest: (link) => resolve(link),
			},
		},
	};
}

test('哈希读取期间被删除的文件不会留下候选或无效告警', async () => {
	const files = [fileOf('a.bin', 'same'), fileOf('b.bin', 'same')];
	const app = mutableApp(files, { 'a.bin': 'same', 'b.bin': 'same' });
	const readBinary = app.vault.readBinary;
	app.vault.readBinary = async (file) => {
		if (file.path === 'a.bin') {
			app.remove('a.bin');
			throw new Error('文件已不存在');
		}
		return readBinary(file);
	};
	const result = await findDuplicateFiles(app);
	assert.deepEqual(result.groups, []);
	assert.deepEqual(result.warnings, []);
});

test('引用清理跳过本身就是删除目标的笔记', async () => {
	const { app, contents, processed } = noteApp([{
		path: 'a.md',
		content: 'self ![[a.md]]',
		embeds: [{ original: '![[a.md]]', link: 'a.md', position: { start: { offset: 5 }, end: { offset: 15 } } }],
		resolved: { 'a.md': 1 },
	}]);
	const result = await removeFileReferencesForFiles(app, ['a.md']);
	assert.deepEqual(processed, []);
	assert.deepEqual(result, { removed: 0, failed: [] });
	assert.equal(contents.get('a.md'), 'self ![[a.md]]');
});

test('同组重复 Markdown 中，只有保留下来的笔记会被清理引用', async () => {
	const notes = [
		{
			path: 'a.md',
			content: 'see [[b]]',
			links: [{ original: '[[b]]', link: 'b', position: { start: { offset: 4 }, end: { offset: 9 } } }],
			resolved: { 'b.md': 1 },
		},
		{
			path: 'b.md',
			content: 'see [[b]]',
			links: [{ original: '[[b]]', link: 'b', position: { start: { offset: 4 }, end: { offset: 9 } } }],
			resolved: { 'b.md': 1 },
		},
	];
	const { app, contents, processed } = noteApp(notes);
	const result = await removeFileReferencesForFiles(app, ['b.md']);
	assert.deepEqual(processed, ['a.md']);
	assert.equal(result.removed, 1);
	assert.deepEqual(result.failed, []);
	assert.equal(contents.get('a.md'), 'see ');
	assert.equal(contents.get('b.md'), 'see [[b]]');
});

test('整组重复文件同时删除时不会先改写任何一个再按旧哈希删除', async () => {
	const notes = [
		{
			path: 'a.md',
			content: 'see [[b]]',
			links: [{ original: '[[b]]', link: 'b', position: { start: { offset: 4 }, end: { offset: 9 } } }],
			resolved: { 'b.md': 1 },
		},
		{
			path: 'b.md',
			content: 'see [[b]]',
			links: [{ original: '[[b]]', link: 'b', position: { start: { offset: 4 }, end: { offset: 9 } } }],
			resolved: { 'b.md': 1 },
		},
	];
	const { app, contents, processed } = noteApp(notes);
	const groups = [{
		hash: 'same',
		size: notes[0].content.length,
		files: notes.map((note) => ({
			path: note.path,
			extension: 'md',
			size: note.content.length,
			mtime: 1,
			referenced: false,
			referencingNotes: [],
		})),
	}];
	const plan = await planDuplicateDeletion(app, groups, ['a.md', 'b.md']);
	assert.deepEqual(plan.deletable.map((file) => file.path).sort(), ['a.md', 'b.md']);
	const result = await removeFileReferencesForFiles(app, ['a.md', 'b.md']);
	assert.deepEqual(processed, []);
	assert.deepEqual(result, { removed: 0, failed: [] });
	assert.equal(contents.get('a.md'), contents.get('b.md'));
});
