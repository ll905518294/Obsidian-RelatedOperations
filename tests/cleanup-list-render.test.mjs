import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { performance } from 'node:perf_hooks';

// Minimal DOM shim: enough for the cleanup list renderers, without adding a dependency.
class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.parent = null;
		this.dataset = {};
		this.style = { setProperty() {} };
		this.className = '';
		this.attrs = {};
		this._text = '';
		this._listeners = [];
		this.disabled = false;
		this.checked = false;
		this.type = '';
		this.title = '';
		this.src = '';
		this.value = '';
		this.selected = false;
	}
	createDiv(options) { return this.createEl('div', options); }
	createSpan(options) { return this.createEl('span', options); }
	createEl(tag, options = {}) {
		const el = new El(tag);
		if (options.cls) el.className = options.cls;
		if (options.text !== undefined) el.setText(options.text);
		if (options.attr) for (const [key, value] of Object.entries(options.attr)) el.setAttribute(key, value);
		if (options.type !== undefined) el.type = options.type;
		if (options.value !== undefined) el.value = options.value;
		this.children.push(el);
		el.parent = this;
		return el;
	}
	setText(text) { this._text = String(text); }
	get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
	addClass(...names) { for (const name of names) if (!this.hasClass(name)) this.className = this.className ? `${this.className} ${name}` : name; }
	removeClass(name) { this.className = this.className.split(/\s+/).filter((item) => item && item !== name).join(' '); }
	hasClass(name) { return this.className.split(/\s+/).includes(name); }
	toggleClass(name, force) { const want = force === undefined ? !this.hasClass(name) : force; if (want) this.addClass(name); else this.removeClass(name); }
	setAttribute(key, value) { this.attrs[key] = String(value); }
	appendText(text) { this._text += String(text); }
	addEventListener(type, callback) { this._listeners.push({ type, callback }); }
	dispatch(type, event = {}) {
		for (const listener of [...this._listeners]) {
			if (listener.type === type) listener.callback({ preventDefault() {}, stopPropagation() {}, target: this, ...event });
		}
	}
	remove() { if (this.parent) { const index = this.parent.children.indexOf(this); if (index >= 0) this.parent.children.splice(index, 1); this.parent = null; } }
	replaceWith(node) { if (!this.parent) return; const index = this.parent.children.indexOf(this); if (index >= 0) { this.parent.children[index] = node; node.parent = this.parent; } }
	empty() { this.children = []; this._text = ''; }
	get previousElementSibling() { if (!this.parent) return null; const index = this.parent.children.indexOf(this); return index > 0 ? this.parent.children[index - 1] : null; }
	get ownerDocument() { return { activeElement: null }; }
	contains(node) { return descendants(this).includes(node); }
	insertBefore(node, reference) { const index = reference ? this.children.indexOf(reference) : -1; this.children.splice(index < 0 ? this.children.length : index, 0, node); node.parent = this; }
	matches(selector) { return matches(this, selector); }
	querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
	querySelectorAll(selector) { return descendants(this).filter((el) => matches(el, selector)); }
}

function descendants(root) {
	const result = [];
	const visit = (node) => { for (const child of node.children) { result.push(child); visit(child); } };
	visit(root);
	return result;
}

function matches(el, selector) {
	if (selector.includes('input')) {
		if (el.tagName !== 'INPUT') return false;
		if (selector.includes('[type="checkbox"]') && el.type !== 'checkbox') return false;
		if (selector.includes('[data-duplicate-path]') && el.dataset.duplicatePath === undefined) return false;
		return true;
	}
	const last = selector.split(' ').pop();
	if (last.startsWith('.')) return el.hasClass(last.slice(1));
	return false;
}

function nodeCount(root) { return descendants(root).length; }
function listenerCount(root) { return descendants(root).reduce((total, el) => total + el._listeners.length, 0); }
function byTag(root, tag) { return descendants(root).filter((el) => el.tagName === tag.toUpperCase()); }
function byClass(root, cls) { return descendants(root).filter((el) => el.hasClass(cls)); }
function byText(root, tag, text) { return byTag(root, tag).filter((el) => el.textContent === text); }

const stub = `
export class Component {
  callbacks = [];
  register(cb) { this.callbacks.push(cb); }
  registerEvent(ref) { this.register(() => ref?.dispose?.()); }
  registerInterval() {}
  load() { this.onload?.(); }
  unload() { this.callbacks.forEach(cb => cb()); }
}
export class Plugin extends Component {}
export class Modal extends Component { static opens = 0; open() { Modal.opens++; } close() {} }
export class ItemView extends Component {}
export class PluginSettingTab extends Component {}
export class TAbstractFile {}
export class TFile extends TAbstractFile { constructor(path) { super(); this.path = path; this.extension = 'md'; this.name = path.split('/').pop(); this.stat = { size: 0, mtime: 0 }; } }
export class TFolder extends TAbstractFile { constructor(path) { super(); this.path = path; this.children = []; } }
export class App {}
export class FileSystemAdapter {}
export class MarkdownView {}
export class Notice { constructor(message) { Notice.messages.push(message); } static messages = []; }
export const Platform = { isDesktopApp: false };
export const normalizePath = p => p;
export const setIcon = () => {};
`;

const bundle = await build({
	stdin: {
		contents: "export { OrphanCleanupPanel as Panel } from './src/orphan-cleanup.ts'; export { TFile, TFolder, Modal } from 'obsidian';",
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
const { Panel, TFile, Modal } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function makeApp() {
	return {
		vault: {
			getResourcePath: (file) => `app://${file.path}`,
			getAbstractFileByPath: () => null,
			getFiles: () => [],
			getMarkdownFiles: () => [],
			getRoot: () => ({ path: '', children: [] }),
		},
		workspace: { openLinkText: async () => {}, getActiveViewOfType: () => null, getLeavesOfType: () => [] },
		metadataCache: { resolvedLinks: {}, getFileCache: () => null, getFirstLinkpathDest: () => null },
		fileManager: { trashFile: async () => {} },
	};
}

function makePanel() {
	return new Panel(makeApp(), new El('div'), { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
}

function makeFile(path, extension, size = 1024) {
	const file = new TFile(path);
	file.extension = extension;
	file.stat = { size, mtime: 0 };
	return file;
}

function link(path, offset) {
	return { sourcePath: 'note.md', original: '![[missing.png]]', linkPath: path, position: { start: { offset }, end: { offset: offset + 10 } } };
}

test('共享列表路径仍按路径分组渲染附件', () => {
	const panel = makePanel();
	panel.activeTab = 'attachments';
	panel.attachmentGrouping = 'path';
	panel.candidates.attachments = [
		makeFile('A/one.pdf', 'pdf', 100),
		makeFile('A/two.pdf', 'pdf', 200),
		makeFile('B/three.pdf', 'pdf', 300),
	];

	panel.renderList();

	const groups = byClass(panel.contentEl, 'orphan-cleanup-group');
	assert.deepEqual(groups.map((row) => row.textContent), ['A（2）', 'B（1）']);
	const tbody = byTag(panel.contentEl, 'tbody');
	assert.equal(tbody.length, 1);
	assert.equal(tbody[0].children.length, 5, '2 个分组行 + 3 个数据行');
	assert.equal(byTag(panel.contentEl, 'input').length, 3);
	assert.equal(byClass(panel.contentEl, 'orphan-cleanup-open-folder').length, 3);
});

test('图片网格保留预览资源路径与点击打开预览', () => {
	const panel = makePanel();
	panel.activeTab = 'images';
	panel.candidates.images = [makeFile('pics/a.png', 'png', 10), makeFile('pics/b.png', 'png', 20)];

	panel.renderList();

	const cards = byClass(panel.contentEl, 'orphan-cleanup-image-card');
	assert.equal(cards.length, 2);
	const previews = byTag(panel.contentEl, 'img');
	assert.equal(previews.length, 2);
	assert.deepEqual(previews.map((img) => img.src), ['app://pics/a.png', 'app://pics/b.png']);
	assert.ok(previews.every((img) => img.title === '点击预览'));
	assert.ok(previews.every((img) => img.attrs.alt.endsWith('预览')));

	const before = Modal.opens;
	previews[0].dispatch('click');
	assert.equal(Modal.opens, before + 1);
});

test('重复文件组选择可整组切换并同步选择集', () => {
	const panel = makePanel();
	panel.activeTab = 'duplicates';
	panel.candidates.duplicates = [{
		hash: 'abc',
		size: 2048,
		files: [
			{ path: 'dup/a.png', extension: 'png', size: 2048, referenced: false, referencingNotes: [] },
			{ path: 'dup/b.png', extension: 'png', size: 2048, referenced: false, referencingNotes: [] },
		],
	}];

	panel.renderList();

	assert.equal(byClass(panel.contentEl, 'orphan-cleanup-duplicate-group').length, 1);
	const checkboxes = byTag(panel.contentEl, 'input').filter((input) => input.dataset.duplicatePath !== undefined);
	assert.deepEqual(checkboxes.map((input) => input.dataset.duplicatePath), ['dup/a.png', 'dup/b.png']);
	const toggle = byText(panel.contentEl, 'button', '选择本组全部')[0];
	assert.ok(toggle);

	toggle.dispatch('click');
	assert.deepEqual([...panel.duplicateSelections].sort(), ['dup/a.png', 'dup/b.png']);
	assert.deepEqual(checkboxes.map((input) => input.checked), [true, true]);
	assert.equal(toggle.textContent, '取消本组选择');

	toggle.dispatch('click');
	assert.equal(panel.duplicateSelections.size, 0);
	assert.deepEqual(checkboxes.map((input) => input.checked), [false, false]);
	assert.equal(toggle.textContent, '选择本组全部');
});

test('三类链接列表在拆分后仍可全选并保留不可转换项禁用态', () => {
	const brokenPanel = makePanel();
	brokenPanel.activeTab = 'broken-links';
	brokenPanel.candidates.brokenLinks = [link('a.png', 0), link('b.png', 11)];
	brokenPanel.renderList();
	assert.equal(byTag(brokenPanel.contentEl, 'tbody')[0].children.length, 2);
	byText(brokenPanel.contentEl, 'button', '全选全部')[0].dispatch('click');
	assert.equal(brokenPanel.linkSelections.size, 2);

	const notePanel = makePanel();
	notePanel.activeTab = 'broken-note-links';
	notePanel.candidates.brokenNoteLinks = [
		{ sourcePath: 'note.md', original: '[[gone]]', linkPath: 'gone', position: { start: { offset: 0 }, end: { offset: 8 } }, syntax: 'wiki' },
		{ sourcePath: 'other.md', original: '[[gone]]', linkPath: 'gone', position: { start: { offset: 9 }, end: { offset: 17 } }, syntax: 'wiki' },
	];
	notePanel.renderList();
	assert.equal(byTag(notePanel.contentEl, 'tbody')[0].children.length, 2, '同一目标的多条来源仍保留为独立行');
	byText(notePanel.contentEl, 'button', '全选全部')[0].dispatch('click');
	assert.equal(notePanel.noteLinkSelections.size, 2, '同一目标的不同来源必须各有独立选择键');

	const nativePanel = makePanel();
	nativePanel.activeTab = 'native-links';
	nativePanel.candidates.nativeLinks = [
		{ sourcePath: 'note.md', original: '![[a.png]]', linkPath: 'a.png', position: { start: { offset: 0 }, end: { offset: 10 } }, file: makeFile('a.png', 'png') },
		{ sourcePath: 'note.md', original: '![[b.png]]', linkPath: 'b.png', position: { start: { offset: 11 }, end: { offset: 21 } }, file: makeFile('b.png', 'png') },
		{ sourcePath: 'note.md', original: '![[c.png]]', linkPath: 'c.png', position: { start: { offset: 22 }, end: { offset: 32 } }, reason: '未解析目标' },
	];
	nativePanel.renderList();
	const nativeCheckboxes = byTag(nativePanel.contentEl, 'input').filter((input) => input.type === 'checkbox');
	assert.deepEqual(nativeCheckboxes.map((input) => input.disabled), [false, false, true]);
	byText(nativePanel.contentEl, 'button', '全选全部')[0].dispatch('click');
	assert.equal(nativePanel.nativeSelections.size, 2);
});

test('1000 个候选时单页 DOM 与监听数量保持常数级', () => {
	const panel = makePanel();
	panel.activeTab = 'attachments';
	panel.attachmentGrouping = 'none';
	panel.candidates.attachments = Array.from({ length: 1000 }, (_, index) => makeFile(`F${index % 10}/file-${index}.pdf`, 'pdf', index));

	const measure = (pages) => {
		const start = performance.now();
		const iterations = 20;
		for (let index = 0; index < iterations; index++) {
			panel.contentEl.empty();
			panel.pages = new Map(pages);
			panel.renderList();
		}
		const elapsed = performance.now() - start;
		return elapsed / iterations;
	};

	const firstPageMs = measure([]);
	const firstNodes = nodeCount(panel.contentEl);
	const firstListeners = listenerCount(panel.contentEl);
	panel.contentEl.empty();
	panel.pages = new Map();
	panel.renderList();
	assert.equal(byTag(panel.contentEl, 'tbody')[0].children.length, 100);

	const lastPageMs = measure([['attachments', 9]]);
	panel.contentEl.empty();
	panel.pages = new Map();
	panel.renderList();
	assert.equal(byTag(panel.contentEl, 'tbody')[0].children.length, 100);

	panel.activeTab = 'images';
	panel.candidates.images = Array.from({ length: 1000 }, (_, index) => makeFile(`pics/${index}.png`, 'png', index));
	panel.pages = new Map();
	panel.contentEl.empty();
	panel.renderList();
	const imageCards = byClass(panel.contentEl, 'orphan-cleanup-image-card').length;
	const imageNodes = nodeCount(panel.contentEl);
	const imageListeners = listenerCount(panel.contentEl);

	console.log(`[cleanup-render] 附件首页 ${firstPageMs.toFixed(2)}ms/页, 末页 ${lastPageMs.toFixed(2)}ms/页；节点 ${firstNodes}，监听 ${firstListeners}`);
	console.log(`[cleanup-render] 图片首页 ${imageCards} 卡片，节点 ${imageNodes}，监听 ${imageListeners}`);

	assert.equal(imageCards, 100);
	assert.ok(firstNodes < 5000, `1000 候选时单页节点数应受限，实际 ${firstNodes}`);
	assert.ok(firstListeners < 1500, `1000 候选时单页监听数应受限，实际 ${firstListeners}`);
	assert.ok(imageNodes < 3000, `1000 图片时单页节点数应受限，实际 ${imageNodes}`);
	assert.ok(imageListeners < 1000, `1000 图片时单页监听数应受限，实际 ${imageListeners}`);
});
