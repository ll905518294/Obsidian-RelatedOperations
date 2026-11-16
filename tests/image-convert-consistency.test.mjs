import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const stub = `
export class TAbstractFile {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
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
		contents: `
			export { estimateConversions } from './src/cleanup/cleanup-scan.ts';
			export { runImageConversion } from './src/image-convert/image-convert-runner.ts';
		`,
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

const { estimateConversions, runImageConversion } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const encoder = new TextEncoder();
const bytesOf = (size) => new Uint8Array(size).buffer;
const config = { sources: ['png'], target: 'webp', quality: 85, alpha: 'flatten' };

function span(content, original, from = 0) {
	const start = content.indexOf(original, from);
	return { start: { offset: start }, end: { offset: start + original.length } };
}

function embedsFor(content, target) {
	const original = `![[${target}]]`;
	const embeds = [];
	let cursor = 0;
	for (let found = content.indexOf(original, cursor); found >= 0; found = content.indexOf(original, cursor)) {
		embeds.push({ link: target, original, position: span(content, original, found) });
		cursor = found + original.length;
	}
	return embeds;
}

function createApp(notes, images) {
	const files = new Map();
	for (const [path, content] of Object.entries(notes)) {
		files.set(path, {
			path,
			extension: 'md',
			stat: { size: content.length, mtime: 1 },
			content,
			binary: encoder.encode(content).buffer,
		});
	}
	for (const [path, size] of Object.entries(images)) {
		files.set(path, {
			path,
			extension: 'png',
			stat: { size, mtime: 1 },
			content: '',
			binary: bytesOf(size),
		});
	}
	const resolve = (link, sourcePath) => {
		const clean = link.trim().replace(/^<|>$/g, '').split('#')[0];
		const directory = sourcePath.includes('/') ? `${sourcePath.slice(0, sourcePath.lastIndexOf('/'))}/` : '';
		return files.get(`${directory}${clean}`) ?? files.get(clean) ?? null;
	};
	return {
		files,
		vault: {
			getFiles: () => [...files.values()],
			getFileByPath: (path) => files.get(path) ?? null,
			cachedRead: async (file) => file.content,
			read: async (file) => file.content,
			readBinary: async (file) => file.binary,
			process: async (file, change) => {
				const next = change(file.content);
				file.content = next;
				file.binary = encoder.encode(next).buffer;
				file.stat = { ...file.stat, size: next.length, mtime: file.stat.mtime + 1 };
				return next;
			},
			createBinary: async (path, data) => {
				if (files.has(path)) throw new Error('已存在');
				const file = { path, extension: path.split('.').at(-1), stat: { size: data.byteLength, mtime: 1 }, content: '', binary: data };
				files.set(path, file);
				return file;
			},
			delete: async (file) => { files.delete(file.path); },
			getAbstractFileByPath: (path) => files.get(path) ?? null,
		},
		metadataCache: {
			resolvedLinks: {},
			getFileCache: (file) => ({ embeds: embedsFor(file.content, 'img.png') }),
			getFirstLinkpathDest: resolve,
		},
		fileManager: { trashFile: async (file) => { files.delete(file.path); } },
	};
}

function createCodec() {
	return {
		decode: async () => ({ ok: true, image: { width: 10, height: 10, hasAlpha: false } }),
		encode: async () => ({ ok: true, bytes: bytesOf(40) }),
	};
}

test('估算的 referenceCount 与转换实际改写的引用数量一致', async () => {
	const content = '![[img.png]] and ![[img.png]]';
	const app = createApp({ 'note.md': content }, { 'img.png': 100 });
	app.metadataCache.resolvedLinks = { 'note.md': { 'img.png': 2 } };
	const codec = createCodec();
	const items = await estimateConversions(app, [app.files.get('img.png')], config, codec);
	assert.equal(items.length, 1);
	assert.equal(items[0].blockedReason, undefined);
	assert.equal(items[0].referenceCount, 2);

	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(result.converted.length, 1);
	assert.equal(app.files.get('note.md').content, '![](<img.webp>) and ![](<img.webp>)');
});

test('估算之后新增的引用会在转换时全部改写，不会按旧计数少改', async () => {
	const app = createApp({ 'note.md': '![[img.png]]' }, { 'img.png': 100 });
	app.metadataCache.resolvedLinks = { 'note.md': { 'img.png': 1 } };
	const codec = createCodec();
	const items = await estimateConversions(app, [app.files.get('img.png')], config, codec);
	assert.equal(items[0].referenceCount, 1);

	const note = app.files.get('note.md');
	note.content = '![[img.png]] and ![[img.png]]';
	app.metadataCache.resolvedLinks = { 'note.md': { 'img.png': 2 } };

	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(result.converted.length, 1);
	assert.equal(note.content, '![](<img.webp>) and ![](<img.webp>)');
});

test('原图在估算之后发生变化时，转换跳过而不是静默改写', async () => {
	const app = createApp({ 'note.md': '![[img.png]]' }, { 'img.png': 100 });
	app.metadataCache.resolvedLinks = { 'note.md': { 'img.png': 1 } };
	const codec = createCodec();
	const image = app.files.get('img.png');
	const estimated = { path: image.path, size: image.stat.size, mtime: image.stat.mtime };
	image.stat = { size: 100, mtime: 9 };

	const result = await runImageConversion(app, codec, [estimated], { target: 'webp' });
	assert.equal(result.converted.length, 0);
	assert.equal(result.skipped.length, 1);
	assert.equal(result.skipped[0].reason, 'file-changed');
	assert.equal(app.files.get('note.md').content, '![[img.png]]');
	assert.equal(app.files.has('img.webp'), false);
});
