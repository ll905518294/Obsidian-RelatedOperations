import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

class El {
	constructor(tag, opts = {}) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.parent = null;
		this.dataset = {};
		this.attrs = {};
		this.listeners = new Map();
		this.classList = new Set();
		this._text = '';
		this.disabled = false;
		this.checked = false;
		this.value = opts.value ?? '';
		this.type = opts.type;
		this.src = '';
		this.style = { setProperty() {} };
		if (opts.cls) for (const name of String(opts.cls).split(/\s+/)) if (name) this.classList.add(name);
	}
	get className() { return [...this.classList].join(' '); }
	set className(value) { this.classList = new Set(String(value).split(/\s+/).filter(Boolean)); }
	get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
	set textContent(value) { this._text = String(value); this.children = []; }
	setText(value) { this.textContent = value; }
	appendText(value) { this._text += String(value); }
	addClass(...names) { for (const name of names) for (const part of String(name).split(/\s+/)) if (part) this.classList.add(part); }
	removeClass(...names) { for (const name of names) this.classList.delete(name); }
	hasClass(name) { return this.classList.has(name); }
	setAttribute(key, value) { this.attrs[key] = String(value); }
	getAttribute(key) { return this.attrs[key] ?? null; }
	createEl(tag, opts = {}) {
		const child = new El(tag, opts);
		if (opts.text !== undefined) child.textContent = opts.text;
		if (opts.type !== undefined) child.type = opts.type;
		if (opts.value !== undefined) child.value = opts.value;
		if (opts.attr) Object.assign(child.attrs, opts.attr);
		child.parent = this;
		this.children.push(child);
		return child;
	}
	createDiv(opts = {}) { return this.createEl('div', opts); }
	createSpan(opts = {}) { return this.createEl('span', opts); }
	addEventListener(name, callback) {
		const list = this.listeners.get(name) ?? [];
		list.push(callback);
		this.listeners.set(name, list);
	}
	fire(name, event = {}) {
		for (const callback of this.listeners.get(name) ?? []) {
			callback({ preventDefault() {}, stopPropagation() {}, target: this, ...event });
		}
	}
	dispatchEvent(event) { this.fire(event.type, event); return true; }
	focus(options) {
		this.lastFocusOptions = options;
		(globalThis.__focusLog ??= []).push(this);
	}
	empty() {
		for (const child of this.children) child.parent = null;
		this.children = [];
		this._text = '';
	}
	remove() {
		if (!this.parent) return;
		this.parent.children = this.parent.children.filter((child) => child !== this);
		this.parent = null;
	}
	get parentElement() { return this.parent; }
	*descendants() {
		for (const child of this.children) {
			yield child;
			yield* child.descendants();
		}
	}
	querySelectorAll(selector) {
		return [...this.descendants()].filter((element) => matches(element, selector));
	}
	querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function matches(element, selector) {
	if (selector.startsWith('.')) return element.hasClass(selector.slice(1));
	if (/^[a-z]+$/i.test(selector)) return element.tagName === selector.toUpperCase();
	return false;
}

globalThis.El = El;
globalThis.window = {
	setTimeout: (callback) => setTimeout(callback, 0),
	clearTimeout,
	setInterval: () => 0,
	clearInterval() {},
};

const stub = `
export class TAbstractFile {}
export class TFile extends TAbstractFile {
	constructor(path) {
		super();
		this.path = path;
		this.name = path.split('/').pop();
		this.extension = 'png';
		this.stat = { size: 1, mtime: 0 };
	}
}
export class TFolder extends TAbstractFile {
	constructor(path) { super(); this.path = path; this.children = []; }
}
export class App {}
export class FileSystemAdapter {}
export class MarkdownView {}
export class Notice {
	constructor(message) { Notice.messages.push(message); }
	static messages = [];
}
export const Platform = { isDesktopApp: false };
export const normalizePath = (path) => path;
export const setIcon = () => {};
export class Modal {
	constructor(app) {
		this.app = app;
		this.modalEl = new globalThis.El('div');
		this.titleEl = new globalThis.El('h2');
		this.contentEl = new globalThis.El('div');
		this.scope = { register() {} };
	}
	open() { Modal.last = this; Modal.opens += 1; this.onOpen?.(); }
	close() { this.onClose?.(); }
}
Modal.opens = 0;
`;

const bundle = await build({
	stdin: {
		contents: `
			export { OnboardingModal } from './src/onboarding.ts';
			export { ImagePreviewModal, CreateNotesConfirmationModal, RemoveBrokenLinksConfirmationModal, ConvertNativeLinksConfirmationModal, ConvertWikiLinksConfirmationModal } from './src/cleanup/cleanup-modals.ts';
			export { renderDuplicateGroups } from './src/cleanup/cleanup-list-duplicates.ts';
			export { createColumnHeader } from './src/cleanup/cleanup-a11y.ts';
			export { Modal, TFile } from 'obsidian';
		`,
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'node',
	loader: { '.png': 'dataurl' },
	plugins: [{
		name: 'obsidian-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub }));
		},
	}],
});
const { OnboardingModal, ImagePreviewModal, CreateNotesConfirmationModal, RemoveBrokenLinksConfirmationModal, ConvertNativeLinksConfirmationModal, ConvertWikiLinksConfirmationModal, renderDuplicateGroups, createColumnHeader, Modal, TFile } = await import(
	`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

function makeApp() {
	return {
		vault: {
			getAbstractFileByPath: (path) => (path === 'dup/a.png' ? new TFile(path) : null),
			getResourcePath: (file) => `app://${file.path}`,
		},
		workspace: { openLinkText: async () => {} },
	};
}

test('使用引导切换步骤后焦点回到新步骤标题', () => {
	const modal = new OnboardingModal({}, { name: 'Vault Doctor', version: '1.7.0' });
	globalThis.__focusLog = [];
	modal.open();

	assert.equal(modal.titleEl.attrs.tabindex, '-1');
	assert.equal(globalThis.__focusLog.at(-1), modal.titleEl);

	const next = modal.contentEl.querySelectorAll('button').find((button) => button.textContent === '下一步');
	assert.ok(next, '第一步应有下一步按钮');
	next.fire('click');

	assert.match(modal.titleEl.textContent, /第 2\/3 步/);
	assert.equal(globalThis.__focusLog.at(-1), modal.titleEl);
});

test('预览弹窗没有删除回调时不渲染删除按钮', () => {
	const modal = new ImagePreviewModal(makeApp(), [new TFile('dup/a.png')], 0);
	modal.open();

	assert.equal(
		modal.contentEl.querySelectorAll('button').some((button) => button.textContent === '删除'),
		false,
	);
});

test('预览弹窗有删除回调时保留删除按钮', () => {
	const modal = new ImagePreviewModal(makeApp(), [new TFile('dup/a.png')], 0, async () => {});
	modal.open();

	assert.equal(
		modal.contentEl.querySelectorAll('button').some((button) => button.textContent === '删除'),
		true,
	);
});

test('重复文件预览弹窗不再暴露空删除按钮', () => {
	const root = new El('div');
	renderDuplicateGroups({
		app: makeApp(),
		duplicateSelections: new Set(),
		scanningTabs: new Set(),
		dirtyTabs: new Set(),
		deleteDuplicateFile: async () => {},
	}, root, [{
		hash: 'abc',
		size: 2,
		files: [{ path: 'dup/a.png', extension: 'png', size: 2, referenced: false, referencingNotes: [] }],
	}]);

	const preview = root.querySelectorAll('img').find((image) => image.hasClass('orphan-cleanup-duplicate-preview'));
	assert.ok(preview, '重复组应渲染预览图');
	preview.fire('click');

	const opened = Modal.last;
	assert.ok(opened);
	assert.equal(
		opened.contentEl.querySelectorAll('button').some((button) => button.textContent === '删除'),
		false,
	);
});

test('表头工厂统一输出 scope=col', () => {
	const row = new El('tr');
	createColumnHeader(row, '选择');
	createColumnHeader(row, '文件');

	assert.equal(row.children.length, 2);
	assert.deepEqual(row.children.map((th) => th.textContent), ['选择', '文件']);
	assert.deepEqual(row.children.map((th) => th.attrs.scope), ['col', 'col']);
});

test('重复文件表的表头全部带 scope=col', () => {
	const root = new El('div');
	renderDuplicateGroups({
		app: makeApp(),
		duplicateSelections: new Set(),
		scanningTabs: new Set(),
		dirtyTabs: new Set(),
		deleteDuplicateFile: async () => {},
	}, root, [{
		hash: 'abc',
		size: 2,
		files: [{ path: 'dup/a.png', extension: 'png', size: 2, referenced: false, referencingNotes: [] }],
	}]);

	const headers = root.querySelectorAll('th');
	assert.equal(headers.length, 7);
	assert.deepEqual(headers.map((th) => th.textContent), ['选择', '预览', '文件', '所在笔记', '所在文件夹', '状态', '操作']);
	assert.ok(headers.every((th) => th.attrs.scope === 'col'), '每个表头都需要 scope=col');
});

test('确认弹窗与预览弹窗都声明对话框语义并指向标题', () => {
	const dialogs = [
		new CreateNotesConfirmationModal(makeApp(), 2),
		new RemoveBrokenLinksConfirmationModal(makeApp(), 1, 1),
		new ConvertNativeLinksConfirmationModal(makeApp(), 1),
		new ConvertWikiLinksConfirmationModal(makeApp(), 1),
		new ImagePreviewModal(makeApp(), [new TFile('dup/a.png')], 0),
	];

	for (const modal of dialogs) {
		modal.open();
		assert.equal(modal.modalEl.attrs.role, 'dialog');
		assert.equal(modal.modalEl.attrs['aria-modal'], 'true');
		assert.ok(modal.modalEl.attrs['aria-labelledby'], '对话框需要标题作为可访问名称');
		assert.equal(modal.titleEl.attrs.id, modal.modalEl.attrs['aria-labelledby']);
	}
});
