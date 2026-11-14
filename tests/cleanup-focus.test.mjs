import test from 'node:test';
import assert from 'node:assert/strict';
import { captureViewSnapshot, restoreViewSnapshot } from '../src/cleanup/cleanup-focus.ts';

class Doc {
	activeElement = null;
}

class El {
	constructor(tag, doc) {
		this.tagName = String(tag).toUpperCase();
		this.doc = doc;
		this.children = [];
		this.parent = null;
		this.attrs = {};
		this.dataset = {};
		this._text = '';
		this.scrollTop = 0;
		this.lastFocusOptions = undefined;
	}
	createEl(tag, options = {}) {
		const el = new El(tag, this.doc);
		if (options.cls) el.addClass(...options.cls.split(/\s+/));
		if (options.text !== undefined) el.setText(options.text);
		this.children.push(el);
		el.parent = this;
		return el;
	}
	setText(text) { this._text = String(text); }
	get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
	addClass(...names) { this.className = [...this.className.split(/\s+/).filter(Boolean), ...names].join(' '); }
	get className() { return this._className ?? ''; }
	set className(value) { this._className = value; }
	hasClass(name) { return this.className.split(/\s+/).includes(name); }
	setAttribute(key, value) { this.attrs[key] = String(value); }
	getAttribute(key) { return this.attrs[key] ?? null; }
	focus(options) { this.lastFocusOptions = options; this.doc.activeElement = this; }
	empty() {
		for (const child of this.children) child.parent = null;
		this.children = [];
		this._text = '';
	}
	contains(node) { return node === this || descendants(this).includes(node); }
	querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
	querySelectorAll(selector) { return descendants(this).filter((el) => matches(el, selector)); }
	get ownerDocument() { return this.doc; }
}

function descendants(root) {
	const result = [];
	const visit = (node) => { for (const child of node.children) { result.push(child); visit(child); } };
	visit(root);
	return result;
}

function matches(el, selector) {
	const last = selector.split(' ').pop();
	if (/^[a-zA-Z]+$/.test(last)) return el.tagName === last.toUpperCase();
	if (!last.startsWith('.')) return false;
	return el.hasClass(last.slice(1));
}

function makeRoot() {
	const doc = new Doc();
	return { doc, root: new El('div', doc) };
}

function makeTab(root, label, aria) {
	const button = root.createEl('button', { text: label });
	if (aria) button.setAttribute('aria-label', aria);
	return button;
}

test('恢复 contentEl 内焦点及其同类节点序号', () => {
	const { doc, root } = makeRoot();
	makeTab(root, '扫描', '扫描分类');
	makeTab(root, '扫描', '扫描分类');
	const third = makeTab(root, '扫描', '扫描分类');
	doc.activeElement = third;

	const snapshot = captureViewSnapshot(root);
	assert.deepEqual(snapshot, { tag: 'BUTTON', key: '扫描分类', index: 2, scrollTop: 0, scrollTarget: 'root' });

	root.empty();
	makeTab(root, '扫描', '扫描分类');
	makeTab(root, '扫描', '扫描分类');
	const rebuilt = makeTab(root, '扫描', '扫描分类');
	restoreViewSnapshot(root, snapshot, false);

	assert.equal(doc.activeElement, rebuilt);
	assert.deepEqual(rebuilt.lastFocusOptions, { preventScroll: true });
});

test('同类节点不足时回退到第一个匹配节点', () => {
	const { doc, root } = makeRoot();
	makeTab(root, '扫描', '扫描分类');
	const third = makeTab(root, '扫描', '扫描分类');
	makeTab(root, '扫描', '扫描分类');
	doc.activeElement = third;

	const snapshot = captureViewSnapshot(root);
	root.empty();
	const only = makeTab(root, '扫描', '扫描分类');
	restoreViewSnapshot(root, snapshot, false);

	assert.equal(snapshot.index, 1);
	assert.equal(doc.activeElement, only);
});

test('焦点在 contentEl 外时不生成快照也不抢占焦点', () => {
	const { doc, root } = makeRoot();
	makeTab(root, '扫描', '扫描分类');
	const outside = new El('button', doc);
	doc.activeElement = outside;

	assert.equal(captureViewSnapshot(root), null);
});

test('无焦点且未滚动时返回 null', () => {
	const { root } = makeRoot();
	makeTab(root, '扫描', '扫描分类');
	assert.equal(captureViewSnapshot(root), null);
});

test('整页重建时按开关恢复滚动位置', () => {
	const { doc, root } = makeRoot();
	const scroller = root.createEl('div', { cls: 'orphan-cleanup-scroll' });
	scroller.scrollTop = 320;
	const snapshot = captureViewSnapshot(root);
	assert.deepEqual(snapshot, { tag: '', key: '', index: 0, scrollTop: 320, scrollTarget: 'scroll' });

	root.empty();
	const rebuilt = root.createEl('div', { cls: 'orphan-cleanup-scroll' });
	restoreViewSnapshot(root, snapshot, false);
	assert.equal(rebuilt.scrollTop, 0);

	restoreViewSnapshot(root, snapshot, true);
	assert.equal(rebuilt.scrollTop, 320);
	assert.equal(doc.activeElement, null);
});

test('没有滚动容器时恢复根节点 scrollTop', () => {
	const { root } = makeRoot();
	root.scrollTop = 96;
	const snapshot = captureViewSnapshot(root);
	assert.equal(snapshot.scrollTarget, 'root');

	root.empty();
	root.scrollTop = 0;
	restoreViewSnapshot(root, snapshot, true);
	assert.equal(root.scrollTop, 96);
});
