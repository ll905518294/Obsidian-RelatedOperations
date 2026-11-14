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
		this.src = '';
		this.value = '';
		this.selected = false;
		this.scrollTop = 0;
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
	getAttribute(key) { return this.attrs[key] ?? null; }
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
	if (last.startsWith('.')) return el.hasClass(last.slice(1).replace(/\[.*$/, ''));
	return false;
}

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
		contents: "export { OrphanCleanupPanel as Panel } from './src/orphan-cleanup.ts'; export { TFile, TFolder, Modal, Notice } from 'obsidian';",
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
const { Panel, TFile, Notice } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

globalThis.window ??= globalThis;

function makeApp(overrides = {}) {
	const vault = {
		getResourcePath: (file) => `app://${file.path}`,
		getAbstractFileByPath: () => null,
		getFiles: () => [],
		getMarkdownFiles: () => [],
		getRoot: () => ({ path: '', children: [] }),
		cachedRead: async () => '',
		read: async () => '',
	};
	return {
		vault: { ...vault, ...overrides.vault },
		workspace: { openLinkText: async () => {}, getActiveViewOfType: () => null, getLeavesOfType: () => [] },
		metadataCache: { resolvedLinks: {}, getFileCache: () => null, getFirstLinkpathDest: () => null },
		fileManager: { trashFile: async () => {} },
	};
}

function makePanel(app = makeApp()) {
	return new Panel(app, new El('div'), { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
}

function makeFile(path, extension = 'png', size = 1024) {
	const file = new TFile(path);
	file.extension = extension;
	file.stat = { size, mtime: 0 };
	return file;
}

function byClass(root, cls) { return descendants(root).filter((el) => el.hasClass(cls)); }
function byTag(root, tag) { return descendants(root).filter((el) => el.tagName === tag.toUpperCase()); }
function byId(root, id) { return descendants(root).find((el) => el.attrs.id === id); }

function labelledText(root, checkbox) {
	const labelledBy = checkbox.attrs['aria-labelledby'];
	assert.ok(labelledBy, '复选框必须提供 aria-labelledby');
	return labelledBy.split(/\s+/).map((id) => {
		const target = byId(root, id);
		assert.ok(target, `aria-labelledby 指向不存在的元素：${id}`);
		return target.textContent;
	}).join(' ');
}

function assertLabelsLinked(root) {
	const checkboxes = byTag(root, 'input').filter((input) => input.type === 'checkbox');
	assert.ok(checkboxes.length > 0, '渲染结果应包含复选框');
	for (const checkbox of checkboxes) {
		assert.ok(checkbox.attrs['aria-label'], '保留更完整的 aria-label 描述');
		assert.ok(labelledText(root, checkbox).trim(), '关联文本不应为空');
	}
	const ids = descendants(root).map((el) => el.attrs.id).filter(Boolean);
	assert.equal(new Set(ids).size, ids.length, '同一次渲染内的元素 id 必须唯一');
	return checkboxes;
}

test('扫描失败后保存失败分类与原因并渲染持久横幅', async () => {
	Notice.messages = [];
	const panel = makePanel(makeApp({ vault: { getRoot: () => { throw new Error('资料库根目录读取失败'); } } }));

	await panel.scan();

	assert.deepEqual(panel.lastScanError, {
		reason: '资料库根目录读取失败',
		failedTabs: ['broken-links', 'native-links', 'broken-note-links', 'empty-files', 'folders', 'duplicates'],
	});
	assert.deepEqual([...panel.scannedTabs].sort(), ['attachments', 'images']);
	assert.ok(Notice.messages.some((message) => message === '扫描失败：资料库根目录读取失败'));

	const banner = byClass(panel.contentEl, 'orphan-cleanup-scan-error')[0];
	assert.ok(banner, '概览区应渲染扫描失败横幅');
	assert.equal(banner.attrs.role, 'alert');
	assert.match(banner.textContent, /上次扫描未完成：.*重复文件/);
	assert.match(banner.textContent, /资料库根目录读取失败/);
	assert.match(banner.textContent, /请点击「重新扫描全部」重试/);
});

test('再次扫描开始时立即清除旧错误，成功后横幅消失', async () => {
	const app = makeApp({ vault: { getRoot: () => { throw new Error('资料库根目录读取失败'); } } });
	const panel = makePanel(app);
	await panel.scan();
	assert.ok(panel.lastScanError);

	app.vault.getRoot = () => ({ path: '', children: [] });
	const pending = panel.scan();
	assert.equal(panel.lastScanError, undefined, '手动重扫开始即应清除旧错误');
	await pending;

	assert.equal(panel.lastScanError, undefined);
	assert.equal(byClass(panel.contentEl, 'orphan-cleanup-scan-error').length, 0);
	assert.equal(panel.scannedTabs.size, 8);
});

test('图片卡片与资源行的复选框关联同行可见文本', () => {
	const cardPanel = makePanel();
	cardPanel.activeTab = 'images';
	cardPanel.candidates.images = [makeFile('pics/a.png')];
	cardPanel.renderList();
	const cardCheckbox = assertLabelsLinked(cardPanel.contentEl)[0];
	assert.match(labelledText(cardPanel.contentEl, cardCheckbox), /a\.png/);

	const rowPanel = makePanel();
	rowPanel.activeTab = 'attachments';
	rowPanel.candidates.attachments = [makeFile('A/one.pdf', 'pdf')];
	rowPanel.renderList();
	const rowCheckbox = assertLabelsLinked(rowPanel.contentEl)[0];
	assert.match(labelledText(rowPanel.contentEl, rowCheckbox), /A\/one\.pdf/);

	const folderPanel = makePanel();
	folderPanel.activeTab = 'folders';
	folderPanel.candidates.folders = [{ path: 'Empty/Dir', children: [] }];
	folderPanel.renderList();
	const folderCheckbox = assertLabelsLinked(folderPanel.contentEl)[0];
	assert.match(labelledText(folderPanel.contentEl, folderCheckbox), /Empty\/Dir/);
});

test('同页重建恢复滚动位置，翻页后不沿用旧滚动位置', () => {
	const panel = makePanel();
	panel.activeTab = 'attachments';
	panel.hasScanned = true;
	panel.scannedTabs.add('attachments');
	panel.candidates.attachments = Array.from({ length: 101 }, (_, index) => makeFile(`F/file-${index}.pdf`, 'pdf', index));
	panel.pages.set('attachments', 0);
	panel.renderContents();

	panel.contentEl.querySelector('.orphan-cleanup-scroll').scrollTop = 180;
	panel.renderContents();
	assert.equal(panel.contentEl.querySelector('.orphan-cleanup-scroll').scrollTop, 180, '同页重建应恢复滚动位置');

	panel.contentEl.querySelector('.orphan-cleanup-scroll').scrollTop = 180;
	panel.pages.set('attachments', 1);
	panel.renderContents();
	assert.equal(panel.contentEl.querySelector('.orphan-cleanup-scroll').scrollTop, 0, '翻页属于新视图，不应沿用旧滚动位置');
});

test('重复文件与三类链接的复选框关联路径和链接原文', () => {
	const duplicatePanel = makePanel();
	duplicatePanel.activeTab = 'duplicates';
	duplicatePanel.candidates.duplicates = [{
		hash: 'abc',
		size: 2048,
		files: [
			{ path: 'dup/a.png', extension: 'png', size: 2048, referenced: false, referencingNotes: [] },
			{ path: 'dup/b.png', extension: 'png', size: 2048, referenced: false, referencingNotes: [] },
		],
	}];
	duplicatePanel.renderList();
	const duplicateCheckboxes = assertLabelsLinked(duplicatePanel.contentEl);
	assert.deepEqual(duplicateCheckboxes.map((checkbox) => labelledText(duplicatePanel.contentEl, checkbox).includes('dup/')), [true, true]);

	const brokenPanel = makePanel();
	brokenPanel.activeTab = 'broken-links';
	brokenPanel.candidates.brokenLinks = [{ sourcePath: 'note.md', original: '![[missing.png]]', linkPath: 'missing.png', position: { start: { offset: 0 }, end: { offset: 16 } } }];
	brokenPanel.renderList();
	const brokenText = labelledText(brokenPanel.contentEl, assertLabelsLinked(brokenPanel.contentEl)[0]);
	assert.match(brokenText, /note\.md/);
	assert.match(brokenText, /missing\.png/);

	const nativePanel = makePanel();
	nativePanel.activeTab = 'native-links';
	nativePanel.candidates.nativeLinks = [{ sourcePath: 'note.md', original: '![[a.png]]', linkPath: 'a.png', position: { start: { offset: 0 }, end: { offset: 10 } }, file: makeFile('a.png') }];
	nativePanel.renderList();
	const nativeText = labelledText(nativePanel.contentEl, assertLabelsLinked(nativePanel.contentEl)[0]);
	assert.match(nativeText, /note\.md/);
	assert.match(nativeText, /a\.png/);

	const notePanel = makePanel();
	notePanel.activeTab = 'broken-note-links';
	notePanel.candidates.brokenNoteLinks = [{ sourcePath: 'other.md', original: '[[gone]]', linkPath: 'gone', syntax: 'wiki', position: { start: { offset: 0 }, end: { offset: 8 } } }];
	notePanel.renderList();
	const noteText = labelledText(notePanel.contentEl, assertLabelsLinked(notePanel.contentEl)[0]);
	assert.match(noteText, /other\.md/);
	assert.match(noteText, /gone/);
});
