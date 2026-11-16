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
	get parentElement() { return this.parent; }
	focus(options) { this.lastFocusOptions = options; (globalThis.__focusLog ??= []).push(this); }
	get previousElementSibling() { if (!this.parent) return null; const index = this.parent.children.indexOf(this); return index > 0 ? this.parent.children[index - 1] : null; }
	get ownerDocument() { return { activeElement: null }; }
	contains(node) { return descendants(this).includes(node); }
	insertBefore(node, reference) {
		if (node.parent) { const previous = node.parent.children.indexOf(node); if (previous >= 0) node.parent.children.splice(previous, 1); }
		const index = reference ? this.children.indexOf(reference) : -1;
		this.children.splice(index < 0 ? this.children.length : index, 0, node);
		node.parent = this;
	}
	scrollIntoView(options) { this.scrollCalls = (this.scrollCalls ?? 0) + 1; this.scrollOptions = options; }
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
	assert.ok(previews.every((img) => img.attrs.role === 'button'));
	assert.ok(previews.every((img) => img.hasClass('orphan-cleanup-image-preview')));
	assert.deepEqual(
		previews.map((img) => img.attrs.tabindex),
		['0', '-1'],
		'预览图组使用 roving tabindex，整组只占一个 Tab 停靠点',
	);
	assert.ok(previews.every((img) => img.attrs['aria-haspopup'] === 'dialog'));
	assert.equal(previews[0].attrs['aria-label'], '预览 pics/a.png');
	assert.equal(previews[1].attrs['aria-label'], '预览 pics/b.png');

	const before = Modal.opens;
	previews[0].dispatch('click');
	assert.equal(Modal.opens, before + 1);

	previews[1].dispatch('keydown', { key: 'Enter' });
	assert.equal(Modal.opens, before + 2);
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

test('勾选框留在单元格内，可见文本仍由 aria-labelledby 关联', () => {
	const panel = makePanel();
	panel.activeTab = 'attachments';
	panel.candidates.attachments = [makeFile('A/one.pdf', 'pdf', 100), makeFile('B/two.pdf', 'pdf', 200)];

	panel.renderList();

	const checkboxes = byTag(panel.contentEl, 'input').filter((input) => input.type === 'checkbox');
	assert.equal(checkboxes.length, 2);
	for (const checkbox of checkboxes) {
		// 窄屏命中区由勾选框自己的边框盒承担（content 30px + 7px 透明边框 = 44px），
		// 所以勾选框必须留在单元格内，不能被 label 包裹。
		assert.equal(checkbox.parentElement?.tagName, 'TD', '勾选框应直接放在单元格内，由边框盒提供命中区');
		const labelledBy = checkbox.attrs['aria-labelledby'];
		assert.ok(labelledBy, '勾选框需保留 aria-labelledby');
		const target = byTag(panel.contentEl, 'a').find((link) => link.attrs.id === labelledBy);
		assert.ok(target, `aria-labelledby 应指向行内可见文本：${labelledBy}`);
	}
	assert.equal(byTag(panel.contentEl, 'input').length, 2, '渲染不应残留重复的勾选框节点');
});

test('图片卡片勾选框留在卡片头部且保留可见名称', () => {
	const panel = makePanel();
	panel.activeTab = 'images';
	panel.candidates.images = [makeFile('pics/a.png', 'png', 10)];

	panel.renderList();

	const checkbox = byTag(panel.contentEl, 'input').find((input) => input.type === 'checkbox');
	assert.equal(checkbox.parentElement?.tagName, 'DIV', '勾选框应留在卡片头部容器内');
	assert.ok(checkbox.parentElement.hasClass('orphan-cleanup-image-card-header'), '卡片头部容器应带 orphan-cleanup-image-card-header');
	const name = byClass(panel.contentEl, 'orphan-cleanup-image-name')[0];
	assert.equal(checkbox.attrs['aria-labelledby'], name.attrs.id);
	assert.equal(checkbox.attrs['aria-label'], '选择 a.png');
});

test('帮助按钮通过 aria-controls 指向说明内容，收起后指向不变', () => {
	const panel = makePanel();
	panel.showHelp = true;
	panel.renderContents();

	const helpPanel = byClass(panel.contentEl, 'orphan-cleanup-help')[0];
	const button = byClass(panel.contentEl, 'orphan-cleanup-help-button')[0];
	assert.ok(helpPanel && button);
	assert.equal(button.attrs['aria-expanded'], 'true');
	assert.equal(button.attrs['aria-controls'], helpPanel.attrs.id);
	assert.ok(helpPanel.attrs.id, '说明内容需要有 id 供 aria-controls 指向');

	button.dispatch('click');

	const collapsed = byClass(panel.contentEl, 'orphan-cleanup-help-button')[0];
	assert.equal(collapsed.attrs['aria-expanded'], 'false');
	assert.equal(collapsed.attrs['aria-controls'], helpPanel.attrs.id, '收起后 aria-controls 仍应指向同一 id');
	assert.equal(byClass(panel.contentEl, 'orphan-cleanup-help').length, 0);
});

test('当前分类标签标记 aria-current 并自动滚入可视区', () => {
	const panel = makePanel();
	panel.activeTab = 'duplicates';
	panel.renderContents();

	const tabs = byClass(panel.contentEl, 'orphan-cleanup-tab');
	const active = tabs.filter((tab) => tab.hasClass('is-active'));
	assert.equal(active.length, 1);
	assert.equal(active[0].dataset.tab, 'duplicates');
	assert.equal(active[0].attrs['aria-current'], 'true');
	assert.equal(active[0].scrollCalls, 1, '当前标签需要滚入可视区');
	assert.deepEqual(active[0].scrollOptions, { block: 'nearest', inline: 'nearest' });
	assert.ok(tabs.filter((tab) => tab.attrs['aria-current']).length === 1, '只有当前分类带 aria-current');
});

test('首页分类按钮的无障碍名称包含分类，避免同名按钮无法区分', () => {
	const panel = makePanel();
	panel.candidates.attachments = [makeFile('A/one.pdf', 'pdf', 100)];
	panel.scannedTabs = new Set(['attachments']);
	panel.renderContents();

	const card = byClass(panel.contentEl, 'orphan-cleanup-dashboard-item').find((item) => item.dataset.tab === 'attachments');
	assert.ok(card);
	assert.deepEqual(byTag(card, 'button').map((button) => button.attrs['aria-label']), [
		'未引用附件：重新扫描',
		'未引用附件：查看',
	]);
});

test('所有数据表的表头都带 scope=col，便于屏幕阅读器播报列名', () => {
	const noteLink = { sourcePath: 'note.md', original: '[[gone]]', linkPath: 'gone', position: { start: { offset: 0 }, end: { offset: 8 } }, syntax: 'wiki' };
	const duplicateGroup = {
		hash: 'abc',
		size: 2048,
		files: [{ path: 'dup/a.png', extension: 'png', size: 2048, referenced: false, referencingNotes: [] }],
	};
	const cases = [
		{ tab: 'attachments', setup: (panel) => { panel.candidates.attachments = [makeFile('A/one.pdf', 'pdf', 100)]; } },
		{ tab: 'empty-files', setup: (panel) => { panel.candidates.emptyFiles = [makeFile('Notes/blank.md', 'md', 0)]; } },
		{ tab: 'folders', setup: (panel) => { panel.candidates.folders = [{ path: 'Notes/empty-dir' }]; } },
		{ tab: 'duplicates', setup: (panel) => { panel.candidates.duplicates = [duplicateGroup]; } },
		{ tab: 'broken-links', setup: (panel) => { panel.candidates.brokenLinks = [link('a.png', 0)]; } },
		{ tab: 'native-links', setup: (panel) => { panel.candidates.nativeLinks = [link('a.png', 0)]; } },
		{ tab: 'broken-note-links', setup: (panel) => { panel.candidates.brokenNoteLinks = [noteLink]; } },
		{ tab: 'wiki-links', setup: (panel) => { panel.candidates.wikiLinks = [noteLink]; } },
	];

	for (const item of cases) {
		const panel = makePanel();
		panel.activeTab = item.tab;
		item.setup(panel);
		panel.renderList();

		const headers = byTag(panel.contentEl, 'th');
		assert.ok(headers.length > 0, `${item.tab} 应渲染表头`);
		assert.ok(headers.every((th) => th.attrs.scope === 'col'), `${item.tab} 的每个表头都需要 scope=col`);
	}
});
