import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

// 自带 DOM 垫片：需要类选择器、事件冒泡、可统计的写入次数，
// 才能验证 roving tabindex 的委托键盘处理与 live 区域的去重播报。
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
		this.writeCount = 0;
		this.disabled = false;
		this.checked = false;
		this.isConnected = true;
		this.type = opts.type;
		this.value = opts.value ?? '';
		this.src = '';
		this.title = '';
		this.style = { setProperty() {} };
		if (opts.cls) for (const name of String(opts.cls).split(/\s+/)) if (name) this.classList.add(name);
	}
	get className() { return [...this.classList].join(' '); }
	set className(value) { this.classList = new Set(String(value).split(/\s+/).filter(Boolean)); }
	get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
	set textContent(value) { this._text = String(value); this.children = []; }
	setText(value) { this.writeCount += 1; this.textContent = value; }
	appendText(value) { this._text += String(value); }
	addClass(...names) { for (const name of names) for (const part of String(name).split(/\s+/)) if (part) this.classList.add(part); }
	removeClass(...names) { for (const name of names) this.classList.delete(name); }
	hasClass(name) { return this.classList.has(name); }
	toggleClass(name, force) { const want = force === undefined ? !this.hasClass(name) : force; if (want) this.addClass(name); else this.removeClass(name); }
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
	// 冒泡派发：委托在容器上的键盘处理必须能被成员事件触发。
	fire(name, event = {}) {
		const detail = { defaultPrevented: false, propagationStopped: false, target: this, ...event };
		if (typeof detail.preventDefault !== 'function') detail.preventDefault = () => { detail.defaultPrevented = true; };
		if (typeof detail.stopPropagation !== 'function') detail.stopPropagation = () => { detail.propagationStopped = true; };
		let node = this;
		while (node) {
			for (const callback of [...(node.listeners.get(name) ?? [])]) callback(detail);
			if (detail.propagationStopped) break;
			node = node.parent;
		}
		return detail;
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
		this.isConnected = false;
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
globalThis.document = { activeElement: null };
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
		this.contentEl = new globalThis.El('div');
		this.titleEl = new globalThis.El('h2');
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
			export { applyRovingTabindex, announceStatus, ensureLiveRegion, rememberFocusOrigin, markDialog } from './src/cleanup/cleanup-a11y.ts';
			export { ImagePreviewModal, CreateNotesConfirmationModal, RemoveBrokenLinksConfirmationModal, ConvertNativeLinksConfirmationModal, ConvertWikiLinksConfirmationModal } from './src/cleanup/cleanup-modals.ts';
			export { OnboardingModal } from './src/onboarding.ts';
			export { UpdateIntroModal } from './src/update-intro.ts';
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
const { applyRovingTabindex, announceStatus, ensureLiveRegion, rememberFocusOrigin, markDialog, ImagePreviewModal, CreateNotesConfirmationModal, RemoveBrokenLinksConfirmationModal, ConvertNativeLinksConfirmationModal, ConvertWikiLinksConfirmationModal, OnboardingModal, UpdateIntroModal, TFile } =
	await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function makeApp() {
	return {
		vault: {
			getAbstractFileByPath: () => new TFile('pics/a.png'),
			getResourcePath: (file) => `app://${file.path}`,
		},
		workspace: { openLinkText: async () => {} },
	};
}

function makePreviewSet(count) {
	const container = new El('div');
	const items = [];
	for (let index = 0; index < count; index += 1) {
		const item = container.createDiv({ cls: 'orphan-cleanup-image-preview' });
		item.setAttribute('role', 'button');
		item.setAttribute('tabindex', '0');
		items.push(item);
	}
	return { container, items };
}

test('roving tabindex 让整组预览图只占一个 Tab 停靠点', () => {
	const { container, items } = makePreviewSet(3);
	applyRovingTabindex(container, '.orphan-cleanup-image-preview');

	assert.deepEqual(items.map((item) => item.attrs.tabindex), ['0', '-1', '-1']);
});

test('方向键在 roving 集合内移动焦点并同步 tabindex', () => {
	const { container, items } = makePreviewSet(3);
	applyRovingTabindex(container, '.orphan-cleanup-image-preview');
	globalThis.__focusLog = [];

	const right = items[0].fire('keydown', { key: 'ArrowRight' });
	assert.equal(right.defaultPrevented, true, '方向键必须阻止默认滚动');
	assert.deepEqual(items.map((item) => item.attrs.tabindex), ['-1', '0', '-1']);
	assert.equal(globalThis.__focusLog.at(-1), items[1]);

	items[1].fire('keydown', { key: 'ArrowDown' });
	items[2].fire('keydown', { key: 'ArrowDown' });
	assert.deepEqual(items.map((item) => item.attrs.tabindex), ['-1', '-1', '0'], '到达末尾后停在最后一项');

	items[2].fire('keydown', { key: 'ArrowUp' });
	assert.deepEqual(items.map((item) => item.attrs.tabindex), ['-1', '0', '-1']);

	items[1].fire('keydown', { key: 'Home' });
	assert.deepEqual(items.map((item) => item.attrs.tabindex), ['0', '-1', '-1']);

	items[0].fire('keydown', { key: 'End' });
	assert.deepEqual(items.map((item) => item.attrs.tabindex), ['-1', '-1', '0']);

	items[2].fire('keydown', { key: 'ArrowRight' });
	assert.deepEqual(items.map((item) => item.attrs.tabindex), ['-1', '-1', '0']);
});

test('非成员元素的按键不触发 roving 移动', () => {
	const { container, items } = makePreviewSet(2);
	const outsider = container.createDiv();
	applyRovingTabindex(container, '.orphan-cleanup-image-preview');

	const event = outsider.fire('keydown', { key: 'ArrowRight' });
	assert.equal(event.defaultPrevented, false);
	assert.deepEqual(items.map((item) => item.attrs.tabindex), ['0', '-1']);
});

test('空集合不报错，也不会留下 Tab 停靠点', () => {
	const container = new El('div');
	applyRovingTabindex(container, '.orphan-cleanup-image-preview');
	assert.equal(container.querySelectorAll('.orphan-cleanup-image-preview').length, 0);
});

test('预览弹窗关闭后焦点回到触发元素', () => {
	const trigger = new El('img');
	trigger.setAttribute('tabindex', '0');
	globalThis.document.activeElement = trigger;
	globalThis.__focusLog = [];

	const modal = new ImagePreviewModal(makeApp(), [new TFile('pics/a.png')], 0);
	modal.open();
	modal.close();

	assert.equal(globalThis.__focusLog.at(-1), trigger, '关闭预览弹窗后焦点必须回到触发它的预览图');
	assert.equal(globalThis.__focusLog.at(-1).lastFocusOptions?.preventScroll, true);
});

test('触发元素已被移除时不强行抢焦点', () => {
	const trigger = new El('button');
	globalThis.document.activeElement = trigger;
	globalThis.__focusLog = [];

	const modal = new ImagePreviewModal(makeApp(), [new TFile('pics/a.png')], 0);
	modal.open();
	trigger.isConnected = false;
	modal.close();

	assert.equal(globalThis.__focusLog.length, 0);
});

test('四个确认弹窗关闭后焦点都回到触发按钮', () => {
	const modals = [
		new CreateNotesConfirmationModal(makeApp(), 2),
		new RemoveBrokenLinksConfirmationModal(makeApp(), 1, 1),
		new ConvertNativeLinksConfirmationModal(makeApp(), 1),
		new ConvertWikiLinksConfirmationModal(makeApp(), 1),
	];

	for (const modal of modals) {
		const trigger = new El('button');
		globalThis.document.activeElement = trigger;
		globalThis.__focusLog = [];

		modal.open();
		modal.close();

		assert.equal(globalThis.__focusLog.at(-1), trigger, `${modal.constructor.name} 关闭后应把焦点还给触发按钮`);
	}
});

test('使用引导与更新说明弹窗关闭后焦点回到触发元素', () => {
	const onboarding = new OnboardingModal(makeApp(), { name: 'Vault Doctor', version: '1.7.0' });
	const updateIntro = new UpdateIntroModal(makeApp(), 'Vault Doctor', {
		version: '1.7.0',
		theme: '深色',
		summary: '摘要',
		sections: [{ title: '本次更新', items: ['内容'] }],
	});

	for (const modal of [onboarding, updateIntro]) {
		const trigger = new El('button');
		globalThis.document.activeElement = trigger;
		globalThis.__focusLog = [];

		modal.open();
		modal.close();

		assert.equal(globalThis.__focusLog.at(-1), trigger, `${modal.constructor.name} 关闭后应把焦点还给触发元素`);
	}
});

test('引导与更新说明弹窗也声明对话框语义', () => {
	const onboarding = new OnboardingModal(makeApp(), { name: 'Vault Doctor', version: '1.7.0' });
	const updateIntro = new UpdateIntroModal(makeApp(), 'Vault Doctor', {
		version: '1.7.0',
		theme: '深色',
		summary: '摘要',
		sections: [{ title: '本次更新', items: ['内容'] }],
	});

	for (const modal of [onboarding, updateIntro]) {
		modal.open();
		assert.equal(modal.modalEl.attrs.role, 'dialog');
		assert.equal(modal.modalEl.attrs['aria-modal'], 'true');
		assert.equal(modal.titleEl.attrs.id, modal.modalEl.attrs['aria-labelledby']);
	}
});

test('状态播报只在内容变化时写入 live 区域', () => {
	const root = new El('div');
	ensureLiveRegion(root);
	const region = root.querySelector('.orphan-cleanup-live-status');
	assert.ok(region, 'live 区域必须存在');
	assert.equal(region.attrs.role, 'status');
	assert.equal(region.attrs['aria-live'], 'polite');

	announceStatus(root, '正在扫描：分析引用关系');
	assert.equal(region.textContent, '正在扫描：分析引用关系');
	const writes = region.writeCount;

	announceStatus(root, '正在扫描：分析引用关系');
	assert.equal(region.writeCount, writes, '同一句进度不得重复写入，否则会被反复朗读');

	announceStatus(root, '扫描完成，共 3 项待处理');
	assert.equal(region.writeCount, writes + 1);
	assert.equal(region.textContent, '扫描完成，共 3 项待处理');
});

test('live 区域重建后不会重复播报同一条状态', () => {
	const root = new El('div');
	announceStatus(root, '扫描完成，共 3 项待处理');

	root.empty();
	ensureLiveRegion(root);
	const region = root.querySelector('.orphan-cleanup-live-status');
	assert.equal(region.textContent, '', '重绘后的 live 区域应保持空白，避免重新朗读旧状态');

	announceStatus(root, '扫描完成，共 3 项待处理');
	assert.equal(region.textContent, '', '状态未变化时不得再次写入');
});

test('容器没有 Obsidian DOM 扩展时播报降级而不是抛错', () => {
	const bare = { querySelector: () => null, querySelectorAll: () => [] };
	assert.equal(ensureLiveRegion(bare), undefined);
	assert.doesNotThrow(() => announceStatus(bare, '正在扫描：分析引用关系'));
});

test('reduced-motion 与窄屏规则存在且覆盖到弹窗与首页', () => {
	const css = fs.readFileSync(path.join(process.cwd(), 'styles.css'), 'utf8');
	const reducedBlocks = css.split('@media (prefers-reduced-motion: reduce)').slice(1);
	assert.ok(reducedBlocks.length >= 1, 'styles.css 缺少 prefers-reduced-motion 规则');
	const combined = reducedBlocks.join('\n');
	for (const selector of ['.modal.onboarding-modal', '.modal.update-intro-modal', '.modal.orphan-cleanup-preview-dialog']) {
		assert.ok(combined.includes(selector), `prefers-reduced-motion 未覆盖 ${selector}`);
	}
	assert.ok(combined.includes('transition-duration: 0.001ms !important'));

	assert.ok(css.includes('@media (max-width: 400px)'), 'styles.css 缺少 320-400px 窄屏规则');
	const narrow = css.split('@media (max-width: 400px)').slice(1).join('\n');
	assert.ok(narrow.includes('.orphan-cleanup-dashboard-section-heading'));
	assert.ok(narrow.includes('.orphan-cleanup-dashboard-item-actions'));
});

test('rememberFocusOrigin 在没有活动元素时返回空', () => {
	globalThis.document.activeElement = null;
	assert.equal(rememberFocusOrigin(), undefined);
});

test('markDialog 仍然给出可访问名称', () => {
	const modalEl = new El('div');
	const titleEl = new El('h2');
	markDialog(modalEl, titleEl);
	assert.equal(modalEl.attrs.role, 'dialog');
	assert.equal(modalEl.attrs['aria-modal'], 'true');
	assert.equal(modalEl.attrs['aria-labelledby'], titleEl.attrs.id);
});
