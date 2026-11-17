import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

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
		this.value = '';
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
	dispatch(type, event = {}) { for (const listener of [...this._listeners]) if (listener.type === type) listener.callback({ preventDefault() {}, stopPropagation() {}, target: this, ...event }); }
	remove() { if (this.parent) { const index = this.parent.children.indexOf(this); if (index >= 0) this.parent.children.splice(index, 1); this.parent = null; } }
	empty() { this.children = []; this._text = ''; }
	get parentElement() { return this.parent; }
	focus() {}
	get previousElementSibling() { if (!this.parent) return null; const index = this.parent.children.indexOf(this); return index > 0 ? this.parent.children[index - 1] : null; }
	get ownerDocument() { return { activeElement: null }; }
	contains(node) { return descendants(this).includes(node); }
	insertBefore(node, reference) {
		if (node.parent) { const index = node.parent.children.indexOf(node); if (index >= 0) node.parent.children.splice(index, 1); }
		const index = reference ? this.children.indexOf(reference) : -1;
		this.children.splice(index < 0 ? this.children.length : index, 0, node);
		node.parent = this;
	}
	scrollIntoView() {}
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
	if (selector.includes('button')) return el.tagName === 'BUTTON';
	const last = selector.split(' ').pop();
	if (last.startsWith('.')) return el.hasClass(last.slice(1));
	return false;
}

function byClass(root, cls) { return descendants(root).filter((el) => el.hasClass(cls)); }
function byText(root, tag, text) { return descendants(root).filter((el) => el.tagName === tag.toUpperCase() && el.textContent === text); }

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
		contents: "export { OrphanCleanupPanel as Panel } from './src/orphan-cleanup.ts'; export { tabEntries } from './src/cleanup/cleanup-dashboard.ts'; export { TFile, TFolder } from 'obsidian';",
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
const { Panel, tabEntries, TFile } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function makePanel(tab = 'images') {
	const app = {
		vault: { getResourcePath: (file) => `app://${file.path}`, getAbstractFileByPath: () => null, getFiles: () => [], getMarkdownFiles: () => [], getRoot: () => ({ path: '', children: [] }) },
		workspace: { openLinkText: async () => {}, getActiveViewOfType: () => null, getLeavesOfType: () => [] },
		metadataCache: { resolvedLinks: {}, getFileCache: () => null, getFirstLinkpathDest: () => null },
		fileManager: { trashFile: async () => {} },
	};
	const panel = new Panel(app, new El('div'), { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
	panel.activeTab = tab;
	return panel;
}

test('子页只有顶部一行操作，底部重复动作栏已移除', () => {
	const panel = makePanel('images');
	panel.candidates.images = [new TFile('pics/a.png')];
	panel.renderContents();

	assert.equal(byClass(panel.contentEl, 'orphan-cleanup-actions').length, 0, '不应再渲染底部动作栏');
	const toolbar = byClass(panel.contentEl, 'orphan-cleanup-toolbar')[0];
	assert.ok(toolbar, '应保留顶部工具栏');
	assert.equal(byText(toolbar, 'button', '移入回收站').length, 1, '主执行按钮应在顶部工具栏');
	assert.match(toolbar.textContent, /已选：/, '已选状态文本应在顶部工具栏');
	assert.equal(byClass(toolbar, 'orphan-cleanup-more').length, 1, '应有一个「更多」折叠区');
});

test('「更多」菜单收纳低频按钮：报告与取消选择', () => {
	const panel = makePanel('attachments');
	panel.candidates.attachments = [new TFile('a.pdf')];
	panel.renderContents();

	const moreItems = byClass(panel.contentEl, 'orphan-cleanup-more-items')[0];
	assert.ok(moreItems, '应存在更多菜单项容器');
	for (const label of ['复制报告', '导出报告', '取消当前页选择', '取消全部选择']) {
		assert.equal(byText(moreItems, 'button', label).length, 1, `更多菜单应包含「${label}」`);
	}
	assert.equal(byText(byClass(panel.contentEl, 'orphan-cleanup-toolbar')[0], 'button', '全选当前页').length, 1, '主选择按钮应保留在顶部一行');
});

test('tab 标签显示「图片压缩」且技术标识仍为 image-convert', () => {
	const candidates = {
		images: [], attachments: [], emptyFiles: [], folders: [],
		brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [],
		duplicates: [], duplicateWarnings: [], convertibleImages: [new TFile('a.png')],
	};
	const entries = tabEntries(candidates, false);
	assert.deepEqual(entries.at(-1), ['image-convert', '图片压缩', 1]);
});

test('首页图片压缩卡片标题与查看按钮文案统一', () => {
	const panel = makePanel('overview');
	panel.renderContents();
	const cardText = byClass(panel.contentEl, 'orphan-cleanup-dashboard-item').map((el) => el.textContent).join('\n');
	assert.match(cardText, /图片压缩/, '首页卡片应显示「图片压缩」');
	assert.doesNotMatch(cardText, /图片转换/, '首页卡片不应残留「图片转换」');
});
