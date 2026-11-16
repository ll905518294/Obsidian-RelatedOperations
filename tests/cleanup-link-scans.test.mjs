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
		contents: `
			export { findVaultLinkScans } from './src/cleanup/link-scans.ts';
			export { findBrokenImageLinks } from './src/broken-image-links.ts';
			export { findBrokenNoteLinks } from './src/broken-note-links.ts';
			export { findNativeImageLinks } from './src/native-image-links.ts';
			export { findWikiNoteLinks } from './src/wiki-note-links.ts';
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

const {
	findVaultLinkScans,
	findBrokenImageLinks,
	findBrokenNoteLinks,
	findNativeImageLinks,
	findWikiNoteLinks,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function position(start, end) {
	return { start: { offset: start }, end: { offset: end } };
}

function file(path) {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return { path, name, extension: name.slice(name.lastIndexOf('.') + 1), stat: { size: 1, mtime: 0 } };
}

// 一段同时包含：已解析/未解析图片、原生嵌入、失效笔记链接、代码块与
// frontmatter 内的链接、带标题与块引用的链接。
function makeNote(path, text, cachesById) {
	return { ...file(path), __cache: cachesById[path] ?? null };
}

function cacheFor(text, entries) {
	const used = new Map();
	const range = (needle) => {
		const from = used.get(needle) ?? 0;
		const offset = text.indexOf(needle, from);
		assert.ok(offset >= 0, `fixture 缺少 ${needle}`);
		used.set(needle, offset + needle.length);
		return position(offset, offset + needle.length);
	};
	const embeds = [];
	const links = [];
	for (const entry of entries) {
		(entry.embed ? embeds : links).push({ link: entry.link, original: entry.original, position: range(entry.original) });
	}
	return { embeds, links, sections: [] };
}

function buildApp() {
	const noteText = [
		'---',
		'img: missing-front.png',
		'---',
		'# A',
		'![[ok.png]]',
		'![[missing.png]]',
		'![[native.png|300]]',
		'![[raw.x-raw]]',
		'[[existing#标题]]',
		'[[missing-note]]',
		'[text](missing-markdown.png)',
		'[doc](missing.pdf)',
		'[[target^blk]]',
		'![alt](ok.png)',
		'```',
		'![[in-code.png]]',
		'[[in-code-note]]',
		'```',
	].join('\n');
	const frontmatter = position(0, noteText.indexOf('---', 4) + 3);
	const codeStart = noteText.indexOf('```');
	const code = position(codeStart, noteText.length);
	const cache = cacheFor(noteText, [
		{ embed: true, original: '![[ok.png]]', link: 'ok.png' },
		{ embed: true, original: '![[missing.png]]', link: 'missing.png' },
		{ embed: true, original: '![[native.png|300]]', link: 'native.png|300' },
		{ embed: true, original: '![[raw.x-raw]]', link: 'raw.x-raw' },
		{ embed: false, original: '[[existing#标题]]', link: 'existing#标题' },
		{ embed: false, original: '[[missing-note]]', link: 'missing-note' },
		{ embed: false, original: '[text](missing-markdown.png)', link: 'missing-markdown.png' },
		{ embed: false, original: '[doc](missing.pdf)', link: 'missing.pdf' },
		{ embed: false, original: '[[target^blk]]', link: 'target^blk' },
		{ embed: true, original: '![alt](ok.png)', link: 'ok.png' },
		{ embed: true, original: '![[in-code.png]]', link: 'in-code.png' },
		{ embed: false, original: '[[in-code-note]]', link: 'in-code-note' },
		{ embed: false, original: 'missing-front.png', link: 'missing-front.png' },
	]);
	cache.frontmatterPosition = frontmatter;
	cache.sections = [{ type: 'code', position: code }];

	const notes = [makeNote('notes/a.md', noteText, { 'notes/a.md': cache })];
	notes.push(makeNote('notes/no-cache.md', '', {}));

	const existingFiles = [
		file('assets/ok.png'),
		file('assets/native.png'),
		file('assets/raw.x-raw'),
		file('notes/existing.md'),
		file('notes/target.md'),
	];

	const app = {
		vault: {
			getMarkdownFiles: () => notes,
		},
		metadataCache: {
			getFileCache: (note) => note.__cache,
			getFirstLinkpathDest: (linkPath) => {
				const name = linkPath.slice(Math.max(linkPath.lastIndexOf('/'), linkPath.lastIndexOf('\\')) + 1).toLowerCase();
				return existingFiles.find((target) => target.name.toLowerCase() === name || `${target.name}`.toLowerCase() === `${name}.md`) ?? null;
			},
		},
	};
	return { app, notes };
}

function individual(app, notes, imageExtensions) {
	return {
		brokenLinks: findBrokenImageLinks(app, imageExtensions, notes),
		nativeLinks: findNativeImageLinks(app, imageExtensions, notes),
		brokenNoteLinks: findBrokenNoteLinks(app, imageExtensions, notes),
		wikiLinks: findWikiNoteLinks(app, notes),
	};
}

test('批量入口与四个单扫描器输出完全一致', () => {
	const { app, notes } = buildApp();
	const expected = individual(app, notes, 'png, tar.gz');
	const actual = findVaultLinkScans(app, 'png, tar.gz', notes);
	assert.deepEqual(actual, expected);
	// 每个分类都必须真的扫到内容，否则一致性断言可能是空的。
	assert.ok(actual.brokenLinks.length > 0);
	assert.ok(actual.nativeLinks.length > 0);
	assert.ok(actual.brokenNoteLinks.length > 0);
	assert.ok(actual.wikiLinks.length > 0);
});

test('批量入口每个文件只取一次 metadata cache', () => {
	const { app, notes } = buildApp();
	let calls = 0;
	const original = app.metadataCache.getFileCache;
	app.metadataCache.getFileCache = (note) => {
		calls++;
		return original(note);
	};
	individual(app, notes, 'png');
	const afterIndividual = calls;
	calls = 0;
	findVaultLinkScans(app, 'png', notes);
	assert.equal(afterIndividual, notes.length * 4);
	assert.equal(calls, notes.length);
});

test('扩展名口径与单扫描器一致（parseExtensions 会丢弃的带连字符扩展名）', () => {
	const { app, notes } = buildApp();
	const actual = findVaultLinkScans(app, 'png, x-raw', notes);
	assert.deepEqual(actual.nativeLinks, findNativeImageLinks(app, 'png, x-raw', notes));
	assert.ok(actual.nativeLinks.some((link) => link.linkPath === 'raw.x-raw'));
});

test('空文件列表返回四个空数组', () => {
	const { app } = buildApp();
	assert.deepEqual(findVaultLinkScans(app, 'png', []), {
		brokenLinks: [],
		nativeLinks: [],
		brokenNoteLinks: [],
		wikiLinks: [],
	});
});
