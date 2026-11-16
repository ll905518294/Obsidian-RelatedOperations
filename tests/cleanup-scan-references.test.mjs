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
		contents: "export { markFilesReferencedByText } from './src/cleanup/cleanup-scan.ts';",
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

const { markFilesReferencedByText } = await import(
	`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

function image(path) {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return { path, name, extension: name.slice(name.lastIndexOf('.') + 1), stat: { size: 1 } };
}

function fakeApp(contents) {
	const notes = Object.keys(contents).map((path) => image(path));
	return {
		vault: {
			getMarkdownFiles: () => notes,
			cachedRead: async (file) => contents[file.path] ?? '',
		},
	};
}

async function referencedFor(contents, images) {
	const referenced = new Set();
	await markFilesReferencedByText(fakeApp(contents), images, referenced);
	return [...referenced].sort();
}

test('文字提及按 basename 与带目录路径匹配', async () => {
	const images = [image('assets/photo.png')];
	assert.deepEqual(
		await referencedFor({ 'a.md': 'see photo.png here' }, images),
		['assets/photo.png'],
	);
	assert.deepEqual(
		await referencedFor({ 'a.md': 'see ./assets/photo.png here' }, images),
		['assets/photo.png'],
	);
	assert.deepEqual(
		await referencedFor({ 'a.md': 'no mention' }, images),
		[],
	);
});

test('同名 basename 被保守地全部视为已引用', async () => {
	const images = [image('assets/photo.png'), image('other/photo.png')];
	assert.deepEqual(
		await referencedFor({ 'a.md': 'see photo.png' }, images),
		['assets/photo.png', 'other/photo.png'],
	);
});

test('空格文件名与 URL 编码文件名都能匹配', async () => {
	const images = [image('assets/my photo.png')];
	assert.deepEqual(
		await referencedFor({ 'a.md': 'see my photo.png' }, images),
		['assets/my photo.png'],
	);
	assert.deepEqual(
		await referencedFor({ 'a.md': '![](assets/my%20photo.png)' }, images),
		['assets/my photo.png'],
	);
	assert.deepEqual(
		await referencedFor({ 'a.md': 'see assets/my%20photo.png' }, images),
		['assets/my photo.png'],
	);
});

test('编码的大小写字符在解码后按文件名匹配', async () => {
	const images = [image('assets/a.png')];
	assert.deepEqual(
		await referencedFor({ 'a.md': 'see %61.png' }, images),
		['assets/a.png'],
	);
});

test('括号等非字母字符的文件名通过原文检索匹配', async () => {
	const images = [image('assets/icon (1).png')];
	assert.deepEqual(
		await referencedFor({ 'a.md': 'see icon (1).png in the list' }, images),
		['assets/icon (1).png'],
	);
});

test('超长无标点英文行不会随词数放大匹配开销', { timeout: 3000 }, async () => {
	const words = Array.from({ length: 300 }, (_, index) => `word${index}`).join(' ');
	const contents = {};
	for (let index = 0; index < 2000; index++) {
		contents[`notes/${index}.md`] = `see ${words} target.png\n`;
	}
	const images = [image('assets/target.png'), image('assets/other.png')];
	const referenced = new Set();
	const started = Date.now();
	await markFilesReferencedByText(fakeApp(contents), images, referenced);
	const elapsed = Date.now() - started;
	assert.ok(referenced.has('assets/target.png'));
	assert.ok(elapsed < 1500, `长行匹配耗时 ${elapsed}ms，超过 1500ms`);
});
