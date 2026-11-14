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
		contents: "export { forEachWithConcurrency, findEmptyFiles } from './src/cleanup/cleanup-scan.ts';",
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
const { forEachWithConcurrency, findEmptyFiles } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

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
