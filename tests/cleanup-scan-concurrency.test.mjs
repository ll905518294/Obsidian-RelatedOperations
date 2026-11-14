import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const stub = `
export class TAbstractFile {}
export class TFile {}
export class TFolder {}
export class App {}
export class FileSystemAdapter {}
export class Notice { constructor() {} }
export class Component { register() {} registerEvent() {} registerInterval() {} }
export class Modal extends Component {}
export class ItemView extends Component {}
export class PluginSettingTab extends Component {}
export class MarkdownView {}
export const setIcon = () => {};
export const normalizePath = p => p;
export const Platform = {};
`;

const bundle = await build({
	stdin: {
		contents: "export { forEachWithConcurrency, findEmptyFiles, markFilesReferencedByText } from './src/cleanup/cleanup-scan.ts';",
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'node',
	plugins: [{
		name: 'obsidian-stub',
		setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
			b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub }));
		},
	}],
});

const source = bundle.outputFiles[0].text;
const { forEachWithConcurrency, findEmptyFiles, markFilesReferencedByText } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('forEachWithConcurrency visits every item exactly once', async () => {
	const items = Array.from({ length: 37 }, (_, index) => index);
	const seen = new Set();
	await forEachWithConcurrency(items, 8, async (item) => {
		await new Promise((resolve) => setTimeout(resolve, item % 3));
		seen.add(item);
	});
	assert.equal(seen.size, items.length);
});

test('forEachWithConcurrency handles an empty list', async () => {
	let calls = 0;
	await forEachWithConcurrency([], 8, async () => {
		calls += 1;
	});
	assert.equal(calls, 0);
});

test('forEachWithConcurrency limits the number of active visitors', async () => {
	let active = 0;
	let peak = 0;
	const items = Array.from({ length: 20 }, (_, index) => index);
	await forEachWithConcurrency(items, 4, async () => {
		active += 1;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, 2));
		active -= 1;
	});
	assert.ok(peak <= 4, `peak concurrency ${peak} exceeded the limit`);
});

test('forEachWithConcurrency stops scheduling work after a visitor rejects', async () => {
	const visited = [];
	const run = forEachWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (item) => {
		visited.push(item);
		if (item === 0) throw new Error('boom');
		await new Promise((resolve) => setTimeout(resolve, 15));
	});
	await assert.rejects(run, /boom/);
	const atReject = visited.length;
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(visited.length, atReject, `visited ${JSON.stringify(visited)} after rejection`);
	assert.deepEqual(visited, [0, 1]);
});

test('markFilesReferencedByText marks basename, decoded and raw-search references', async () => {
	const notes = [
		makeFile('n1.md', 'see photo.png, ![x](assets/a%20b.png) and x-(rare).png'),
		makeFile('n2.md', 'nothing here'),
	];
	const images = [
		{ path: 'assets/photo.png', name: 'photo.png', extension: 'png' },
		{ path: 'assets/a b.png', name: 'a b.png', extension: 'png' },
		{ path: 'assets/x-(rare).png', name: 'x-(rare).png', extension: 'png' },
		{ path: 'assets/未引用.png', name: '未引用.png', extension: 'png' },
	];
	const app = { vault: { getMarkdownFiles: () => notes, cachedRead: async (file) => file.__content } };
	const referenced = new Set();
	await markFilesReferencedByText(app, images, referenced);
	assert.deepEqual([...referenced].sort(), ['assets/a b.png', 'assets/photo.png', 'assets/x-(rare).png']);
});

test('markFilesReferencedByText stops reading once every image is referenced', async () => {
	const notes = Array.from({ length: 100 }, (_, index) => makeFile(`n${index}.md`, index === 0 ? 'see photo.png' : 'plain'));
	let reads = 0;
	const app = {
		vault: {
			getMarkdownFiles: () => notes,
			cachedRead: async (file) => { reads += 1; return file.__content; },
		},
	};
	const referenced = new Set();
	await markFilesReferencedByText(app, [{ path: 'assets/photo.png', name: 'photo.png', extension: 'png' }], referenced);
	assert.deepEqual([...referenced], ['assets/photo.png']);
	assert.ok(reads < notes.length, `read ${reads} of ${notes.length} notes`);
});

function makeFile(path, content) {
	return {
		path,
		name: path.split('/').at(-1),
		extension: path.split('.').at(-1).toLowerCase(),
		stat: { size: content.length },
		__content: content,
	};
}

test('findEmptyFiles matches a serial scan and reports full progress', async () => {
	const files = [
		makeFile('b/only-frontmatter.md', '---\ntags: [x]\n---\n'),
		makeFile('a/zero.md', ''),
		makeFile('c/real.md', '# title\n\nbody'),
		makeFile('d/empty.png', ''),
		makeFile('e/board.canvas', '{}'),
	];
	const app = { vault: { cachedRead: async (file) => file.__content } };
	const progress = [];
	const result = await findEmptyFiles(files, new Set(['png']), app, (processed, total, currentFile) => {
		progress.push({ processed, total, currentFile });
	});
	assert.deepEqual(result.map((file) => file.path), ['a/zero.md', 'b/only-frontmatter.md']);
	assert.equal(progress.length, files.length);
	assert.equal(progress.at(-1).processed, files.length);
	assert.equal(progress.at(-1).total, files.length);
});
