import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Minimal DOM good enough for RelatedNotesPanel: createEl/createDiv, dataset,
// classList, checkbox state, querySelector(All) by class/attribute selectors
// the panel actually uses, and Notice capture.
const stub = `
class El {
	constructor(tag, opts = {}) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.parent = null;
		this.dataset = {};
		this.attrs = {};
		this.listeners = {};
		this.classList = new Set();
		this._text = '';
		this.type = opts.type;
		this.checked = false;
		this.disabled = false;
		this.value = opts.value ?? '';
		if (opts.cls) for (const c of String(opts.cls).split(/\\s+/)) if (c) this.classList.add(c);
	}
	get className() { return [...this.classList].join(' '); }
	set className(v) { this.classList = new Set(String(v).split(/\\s+/).filter(Boolean)); }
	addClass(...names) { for (const n of names) for (const c of String(n).split(/\\s+/)) if (c) this.classList.add(c); }
	removeClass(...names) { for (const n of names) this.classList.delete(n); }
	toggleClass(name, force) {
		const on = force ?? !this.classList.has(name);
		if (on) this.classList.add(name); else this.classList.delete(name);
		return on;
	}
	hasClass(name) { return this.classList.has(name); }
	focus() { (globalThis.__focusLog ??= []).push(this); }
	contains(node) { for (let cursor = node; cursor; cursor = cursor.parent) if (cursor === this) return true; return false; }
	get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
	set textContent(v) { this._text = String(v); this.children = []; }
	setText(v) { this.textContent = v; }
	empty() { for (const c of this.children) c.parent = null; this.children = []; }
	createEl(tag, opts = {}) {
		const child = new El(tag, opts);
		if (opts.text !== undefined) child.textContent = opts.text;
		if (opts.type !== undefined) child.type = opts.type;
		if (opts.attr) Object.assign(child.attrs, opts.attr);
		child.parent = this;
		this.children.push(child);
		return child;
	}
	createDiv(opts = {}) { return this.createEl('div', opts); }
	createSpan(opts = {}) { return this.createEl('span', opts); }
	setAttribute(k, v) { this.attrs[k] = String(v); }
	getAttribute(k) { return this.attrs[k]; }
	addEventListener(name, cb) { (this.listeners[name] ??= []).push(cb); }
	fire(name, event = {}) { for (const cb of this.listeners[name] ?? []) cb({ preventDefault() {}, ...event }); }
	dispatchEvent(event) { this.fire(event.type, event); return true; }
	remove() {
		if (!this.parent) return;
		this.parent.children = this.parent.children.filter((c) => c !== this);
		this.parent = null;
	}
	insertBefore(node, ref) {
		if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
		const i = ref ? this.children.indexOf(ref) : -1;
		node.parent = this;
		if (i >= 0) this.children.splice(i, 0, node); else this.children.push(node);
	}
	get firstChild() { return this.children[0] ?? null; }
	*descendants() { for (const c of this.children) { yield c; yield* c.descendants(); } }
	matches(sel) {
		if (sel.startsWith('.')) return this.classList.has(sel.slice(1));
		const m = sel.match(/^([a-z]+)(?:\\[([^\\]=]+)(?:="([^"]*)")?\\])?$/i);
		if (!m) return false;
		if (this.tagName !== m[1].toUpperCase()) return false;
		if (!m[2]) return true;
		const dataKey = m[2].startsWith('data-')
			? m[2].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
			: m[2].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		const actual = m[2] === 'type' ? this.type : this.attrs[m[2]] ?? this.dataset[dataKey];
		return m[3] === undefined ? actual !== undefined : String(actual) === m[3];
	}
	querySelectorAll(sel) {
		const parts = sel.split(/\\s+/).filter(Boolean);
		return [...this.descendants()].filter((el) => {
			if (!el.matches(parts[parts.length - 1])) return false;
			let index = parts.length - 2;
			let node = el.parent;
			while (index >= 0 && node) {
				if (node.matches(parts[index])) index--;
				node = node.parent;
			}
			return index < 0;
		});
	}
	querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
	closest(sel) {
		let node = this;
		while (node) {
			if (node.matches?.(sel)) return node;
			node = node.parent;
		}
		return null;
	}
}
globalThis.window = { setTimeout: (cb) => setTimeout(cb, 0), clearTimeout, setInterval: () => 0, clearInterval() {}, addEventListener() {}, removeEventListener() {} };
globalThis.document = { createElement: (tag) => new El(tag) };
globalThis.Node = El;
globalThis.Event = class { constructor(type) { this.type = type; } };
export class TAbstractFile { constructor(path) { this.path = path; } }
export class TFile extends TAbstractFile {
	constructor(path, extension, basename) {
		super(path);
		this.extension = extension ?? 'md';
		const leaf = path.slice(path.lastIndexOf('/') + 1);
		this.name = leaf;
		this.basename = basename ?? leaf.replace(/\\.[^.]+$/, '');
	}
}
export class TFolder extends TAbstractFile {
	constructor(path) { super(path); this.children = []; }
}
export class Modal {
	constructor(app) {
		this.app = app;
		this.titleEl = document.createElement('h2');
		this.contentEl = document.createElement('div');
	}
	open() { (globalThis.__openModals ??= []).push(this); if (this.onOpen) this.onOpen(); }
	close() {}
}
export class ItemView {
	constructor(leaf) {
		this.leaf = leaf;
		this.app = leaf?.app;
		this.contentEl = document.createElement('div');
	}
	registerEvent() {}
	async setState() {}
}
export class Notice { constructor(message) { Notice.messages.push(message); } static messages = []; }
export const normalizePath = (p) => String(p).replace(/^\\/+|\\/+$/g, '').replace(/\\/\\.\\//g, '/');
export const Platform = {};
export const PluginSettingTab = class { constructor(app, plugin) { this.app = app; this.plugin = plugin; } };
`;
const bundle = await build({
	stdin: { contents: "export { RelatedNotesPanel } from './src/related-notes-modal.ts'; export { RelatedNotesView } from './src/related-notes-view.ts'; export { TFile, TFolder, Notice } from 'obsidian';", resolveDir: process.cwd() },
	bundle: true, write: false, format: 'esm', platform: 'node',
	plugins: [{ name: 'obsidian-stub', setup(b) {
		b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
		b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub }));
	} }],
});
const { RelatedNotesPanel, RelatedNotesView, TFile, TFolder, Notice } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function makeApp(files, resolvedLinks = {}) {
	const renamed = [];
	const opened = [];
	return {
		app: {
			metadataCache: { resolvedLinks, getFileCache: () => ({}) },
			vault: {
				getAllLoadedFiles: () => files,
				getAbstractFileByPath: (p) => files.find((f) => f.path === p) ?? null,
				createFolder: async (p) => { files.push(new TFolder(p)); },
			},
			fileManager: { renameFile: async (file, dest) => { renamed.push([file.path, dest]); file.path = dest; } },
			workspace: {
				openLinkText: async (linkPath, sourcePath, mode) => {
					opened.push([linkPath, sourcePath, mode]);
				},
			},
		},
		renamed,
		opened,
	};
}

function panelFor(relatedNotes, sourceFiles, options = {}) {
	const { app, renamed, opened } = options.app
		? { app: options.app, renamed: options.renamed ?? [], opened: options.opened ?? [] }
		: makeApp(options.files ?? [], options.resolvedLinks ?? {});
	const el = document.createElement('div');
	const panel = new RelatedNotesPanel(
		app, el, sourceFiles[0], sourceFiles, relatedNotes,
		options.host ?? { close() {} },
		undefined, undefined,
		options.settings, options.saveSettings,
		options.initialMerging ?? false, options.onMergingChange,
		options.initialLastMove, options.onLastMoveChange,
	);
	panel.render();
	return { panel, el, renamed, opened, app };
}

const file = (path) => new TFile(path);

// Drive the real move confirmation: moveSelected opens the modal synchronously,
// so the confirm button already exists when it returns its pending promise.
async function moveSelectedConfirmed(panel) {
	globalThis.__openModals = [];
	const moving = panel.moveSelected();
	const modal = globalThis.__openModals.at(-1);
	const confirm = modal.contentEl.querySelectorAll('button').find((button) => button.textContent === '确认整理');
	assert.ok(confirm, '确认整理按钮应存在');
	confirm.fire('click');
	await moving;
}

async function openMoveConfirmation(panel) {
	globalThis.__openModals = [];
	const moving = panel.moveSelected();
	const modal = globalThis.__openModals.at(-1);
	assert.ok(modal, '确认弹窗应打开');
	return {
		modal,
		close: async () => {
			modal.contentEl.querySelectorAll('button').find((button) => button.textContent === '取消').fire('click');
			await moving;
		},
	};
}

test('tab counts dedupe a note that appears from multiple sources', () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t = file('dst/t.md');
	const relatedNotes = [
		{ file: t, relation: 'outgoing', sourceFile: a },
		{ file: t, relation: 'outgoing', sourceFile: b },
	];
	const { panel, el } = panelFor(relatedNotes, [a, b]);
	const tabs = el.querySelectorAll('.related-operations-tab').map((tab) => tab.textContent);
	assert.deepEqual(tabs, ['出链 (1)', '入链 (0)', '双向链接 (0)']);
});

test('bidirectional note is counted in both tabs but not added to their totals', () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const relatedNotes = [{ file: t, relation: 'both', sourceFile: a }];
	const { el } = panelFor(relatedNotes, [a]);
	const tabs = el.querySelectorAll('.related-operations-tab').map((tab) => tab.textContent);
	assert.deepEqual(tabs, ['出链 (1)', '入链 (1)', '双向链接 (1)']);
	const hint = el.querySelector('.related-operations-tabs-hint');
	assert.match(hint.textContent, /不计入独立总数/);
});

test('当前关系标签带 aria-current，切换后焦点保留在标签上', () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const relatedNotes = [
		{ file: t, relation: 'outgoing', sourceFile: a },
		{ file: t, relation: 'incoming', sourceFile: a },
	];
	const { panel, el } = panelFor(relatedNotes, [a]);
	const tabs = el.querySelectorAll('.related-operations-tab');
	assert.equal(tabs[0].attrs['aria-current'], 'true');
	assert.ok(!tabs[1].attrs['aria-current'], '非当前标签不带 aria-current');

	el.ownerDocument = { activeElement: tabs[1] };
	globalThis.__focusLog = [];
	tabs[1].fire('click');
	assert.equal(panel.activeGroup, 'incoming');
	assert.equal(globalThis.__focusLog.at(-1)?.textContent, '入链 (1)', '切换后焦点恢复到新标签');
	assert.equal(el.querySelectorAll('.related-operations-tab')[1].attrs['aria-current'], 'true');
});

test('目标文件夹 label 与 input 关联', () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a]);
	const label = el.querySelector('label');
	const input = el.querySelector('.related-operations-target-folder');
	assert.ok(label && input, 'label 与 input 存在');
	assert.equal(label.attrs['for'], input.id);
	assert.match(String(input.id), /related-operations-folder-input-/);
});

test('select-all-movable selects each target once and skips compliant notes', () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t = file('Pages/t.md');
	const other = file('dst/other.md');
	const relatedNotes = [
		{ file: t, relation: 'outgoing', sourceFile: a },
		{ file: t, relation: 'incoming', sourceFile: b },
		{ file: other, relation: 'outgoing', sourceFile: a },
	];
	const { panel, el } = panelFor(relatedNotes, [a, b]);
	el.querySelector('.related-operations-select-all-action').fire('click');
	const selectedPaths = [...panel.selections.entries()].filter(([, on]) => on).map(([path]) => path);
	assert.deepEqual(selectedPaths, ['Pages/t.md', 'dst/other.md']);
	const summary = el.querySelector('.related-operations-selection-summary').textContent;
	assert.equal(summary, '已选 2 篇（跨标签页）');
	assert.equal(t.path, 'Pages/t.md');
});

test('moving selected notes renames each file once even if listed under two sources', async () => {
	Notice.messages = [];
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t = file('dst/t.md');
	const relatedNotes = [
		{ file: t, relation: 'outgoing', sourceFile: a },
		{ file: t, relation: 'incoming', sourceFile: b },
	];
	const { panel, el, renamed } = panelFor(relatedNotes, [a, b]);
	const target = el.querySelector('.related-operations-target-folder');
	target.value = 'archive';
	target.fire('input');
	const result = await panel.moveFiles('archive', [t, t]);
	assert.deepEqual(result.succeeded, ['archive/t.md']);
	assert.deepEqual(renamed, [['dst/t.md', 'archive/t.md']]);
});

test('panel rejects target folders that escape the vault', async () => {
	Notice.messages = [];
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { panel, el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a]);
	const input = el.querySelector('.related-operations-target-folder');
	input.value = '../outside';
	input.fire('input');
	await panel.moveSelected();
	assert.match(Notice.messages.at(-1), /vault 内/);
});

// A target linked both ways across two sources appears once per source with its
// own relation. It must not be promoted to "both" for a source that only has
// one direction, and each tab must show the row it belongs to.
test('per-source relations stay exact when a target is linked both ways across sources', () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t = file('dst/t.md');
	const relatedNotes = [
		{ file: t, relation: 'outgoing', sourceFile: a },
		{ file: t, relation: 'incoming', sourceFile: b },
	];
	const { el } = panelFor(relatedNotes, [a, b]);
	const relationCells = () => el.querySelectorAll('tr[data-related-path] td').map((td) => td.textContent);
	assert.ok(relationCells().filter((text) => text === '出链').length === 1);
	const incomingTab = el.querySelectorAll('.related-operations-tab').find((tab) => tab.textContent.startsWith('入链'));
	incomingTab.fire('click');
	assert.ok(relationCells().filter((text) => text === '入链').length === 1);
	const tabs = el.querySelectorAll('.related-operations-tab').map((tab) => tab.textContent);
	assert.deepEqual(tabs, ['出链 (1)', '入链 (1)', '双向链接 (0)']);
});

// The same target can appear once per source. They share one selection key, so
// checking one row must check every row for that path, and the group-wide
// select-all state must count unique target paths rather than rows.
test('per-source rows for the same target stay in sync when one is checked', () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t = file('dst/t.md');
	const relatedNotes = [
		{ file: t, relation: 'outgoing', sourceFile: a },
		{ file: t, relation: 'outgoing', sourceFile: b },
	];
	const { el } = panelFor(relatedNotes, [a, b]);
	const rows = () => el.querySelectorAll('tr[data-related-path]');
	const boxes = () => rows().map((row) => row.querySelector('input[type="checkbox"]'));
	assert.equal(rows().length, 2);
	const selectAll = el.querySelector('.related-operations-select-all');

	boxes()[0].checked = true;
	boxes()[0].fire('change');
	assert.deepEqual(boxes().map((box) => box.checked), [true, true]);
	assert.equal(selectAll.textContent, '取消全选当前分组');

	boxes()[1].checked = false;
	boxes()[1].fire('change');
	assert.deepEqual(boxes().map((box) => box.checked), [false, false]);
	assert.equal(selectAll.textContent, '全选当前分组');
});

// Selections are keyed by path across tabs: switching tabs must keep them and
// the summary must keep counting them, while "select all current group" only
// adds the active tab's notes.
test('selection survives tab switches and stays counted across tabs', () => {
	const a = file('src/a.md');
	const outgoing = file('dst/out.md');
	const incoming = file('src/in.md');
	const relatedNotes = [
		{ file: outgoing, relation: 'outgoing', sourceFile: a },
		{ file: incoming, relation: 'incoming', sourceFile: a },
	];
	const { panel, el } = panelFor(relatedNotes, [a]);
	const summary = () => el.querySelector('.related-operations-selection-summary').textContent;
	const rowFor = (path) => el.querySelectorAll('tr[data-related-path]').find((row) => row.dataset.relatedPath === path);
	const box = rowFor('dst/out.md').querySelector('input[type="checkbox"]');
	box.checked = true;
	box.fire('change');
	assert.equal(summary(), '已选 1 篇（跨标签页）：out');
	const incomingTab = el.querySelectorAll('.related-operations-tab').find((tab) => tab.textContent.startsWith('入链'));
	incomingTab.fire('click');
	assert.equal(summary(), '已选 1 篇（跨标签页）：out');
	assert.equal(rowFor('src/in.md').querySelector('input[type="checkbox"]').checked, false);
	el.querySelector('.related-operations-select-all').fire('click');
	assert.deepEqual(
		[...panel.selections.entries()].filter(([, selected]) => selected).map(([path]) => path).sort(),
		['dst/out.md', 'src/in.md'],
	);
	assert.equal(summary(), '已选 2 篇（跨标签页）');
});

// Default (merge off) keeps the per-source view: the same target appears once
// per source row, as before the merge option existed.
test('merge view is off by default and keeps per-source rows', () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t = file('dst/t.md');
	const relatedNotes = [
		{ file: t, relation: 'outgoing', sourceFile: a },
		{ file: t, relation: 'outgoing', sourceFile: b },
	];
	const { el } = panelFor(relatedNotes, [a, b]);
	const mergeButton = el.querySelector('.related-operations-merge-button');
	assert.equal(mergeButton.getAttribute('aria-pressed'), 'false');
	const rows = () => el.querySelectorAll('tr[data-related-path]');
	assert.equal(rows().length, 2);
});

test('关联笔记表头带 scope=col，便于屏幕阅读器播报列名', () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a]);

	const headers = el.querySelectorAll('th');
	assert.ok(headers.length >= 5, '关联笔记表应有表头');
	assert.ok(headers.every((th) => th.getAttribute('scope') === 'col'), '每个表头都需要 scope=col');
});

// Turning the merge option on collapses the same target from multiple sources
// into a single row while leaving tab counts (already deduped by path) unchanged.
test('merge view collapses the same target into one row with a source count', () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t = file('dst/t.md');
	const other = file('dst/other.md');
	const relatedNotes = [
		{ file: t, relation: 'outgoing', sourceFile: a },
		{ file: t, relation: 'outgoing', sourceFile: b },
		{ file: other, relation: 'outgoing', sourceFile: a },
	];
	const { el } = panelFor(relatedNotes, [a, b]);
	const tabsBefore = el.querySelectorAll('.related-operations-tab').map((tab) => tab.textContent);
	el.querySelector('.related-operations-merge-button').fire('click');
	const rows = el.querySelectorAll('tr[data-related-path]');
	assert.equal(rows.length, 2);
	assert.equal(rows.some((row) => row.querySelector('td[colspan]')), false);
	assert.ok(el.querySelectorAll('tr[data-related-path]').length === 2);
	const tabsAfter = el.querySelectorAll('.related-operations-tab').map((tab) => tab.textContent);
	assert.deepEqual(tabsAfter, tabsBefore);
	const targetCells = () => el.querySelectorAll('tr[data-related-path]').map((row) => row.querySelector('.related-operations-path')?.textContent);
	assert.deepEqual(targetCells().filter(Boolean).sort(), ['dst/other.md', 'dst/t.md']);
	const sourceCols = el.querySelectorAll('tr[data-related-path] .related-operations-merge-sources').map((cell) => cell.textContent);
	assert.ok(sourceCols.includes('2 个来源'));
});

// Merged select-all selects each unique target exactly once.
test('merged view select-all picks each unique target once', () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t = file('Pages/t.md');
	const other = file('dst/other.md');
	const relatedNotes = [
		{ file: t, relation: 'outgoing', sourceFile: a },
		{ file: t, relation: 'outgoing', sourceFile: b },
		{ file: other, relation: 'outgoing', sourceFile: a },
	];
	const { panel, el } = panelFor(relatedNotes, [a, b]);
	el.querySelector('.related-operations-merge-button').fire('click');
	el.querySelector('.related-operations-select-all').fire('click');
	const selectedPaths = [...panel.selections.entries()].filter(([, on]) => on).map(([path]) => path);
	assert.deepEqual(selectedPaths.sort(), ['Pages/t.md', 'dst/other.md']);
});

// The "源笔记名目录" shortcut resolves through defaultTargetFolder's contract
// (parent/<basename>) so the exported helper is actually used and cannot go stale.
test('source-note-folder shortcut derives parent/basename target', () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a]);
	const shortcut = el.querySelectorAll('.related-operations-target-shortcuts button').find((b) => b.textContent === '源笔记名目录');
	const input = el.querySelector('.related-operations-target-folder');
	shortcut.fire('click');
	assert.equal(input.value, 'src/a');
});

// The tab-wide qualifier belongs to the selection, not to the note name: a
// single selection must read "已选 1 篇（跨标签页）：<name>", not "<name>（跨标签页）".
test('single selection summary qualifies the selection, not the note name', () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a]);
	const checkbox = el.querySelector('tr[data-related-path]').querySelector('input[type="checkbox"]');
	checkbox.checked = true;
	checkbox.fire('change');
	const summary = el.querySelector('.related-operations-selection-summary').textContent;
	assert.equal(summary, '已选 1 篇（跨标签页）：t');
});

test('initial merge preference is honored and toggles notify the host', () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t = file('dst/t.md');
	const relatedNotes = [
		{ file: t, relation: 'outgoing', sourceFile: a },
		{ file: t, relation: 'outgoing', sourceFile: b },
	];
	const changes = [];
	const { el } = panelFor(relatedNotes, [a, b], { initialMerging: true, onMergingChange: (value) => changes.push(value) });
	assert.equal(el.querySelector('.related-operations-merge-button').getAttribute('aria-pressed'), 'true');
	assert.equal(el.querySelectorAll('tr[data-related-path]').length, 1);
	el.querySelector('.related-operations-merge-button').fire('click');
	assert.deepEqual(changes, [false]);
});

test('view state round-trips the merge preference and saves layout on toggle', async () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t = file('dst/t.md');
	const byPath = new Map([[a.path, a], [b.path, b], [t.path, t]]);
	let saves = 0;
	const app = {
		metadataCache: {
			resolvedLinks: { 'src/a.md': { 'dst/t.md': 1 }, 'src/b.md': { 'dst/t.md': 1 } },
			getFileCache: () => ({}),
		},
		vault: {
			getAbstractFileByPath: (path) => byPath.get(path) ?? null,
			getAllLoadedFiles: () => [...byPath.values()],
			createFolder: async () => {},
		},
		fileManager: { renameFile: async () => {} },
		workspace: {
			openLinkText: async () => {},
			requestSaveLayout: () => { saves++; return Promise.resolve(); },
		},
	};
	const view = new RelatedNotesView({ app }, { groupingMode: 'none', hideCompliant: true }, async () => {});
	await view.setState({ sourcePaths: ['src/a.md', 'src/b.md'], mergeTargetView: true }, { history: false });
	assert.deepEqual(view.getState(), { sourcePaths: ['src/a.md', 'src/b.md'], mergeTargetView: true });
	const mergeButton = view.contentEl.querySelector('.related-operations-merge-button');
	assert.equal(mergeButton.getAttribute('aria-pressed'), 'true');
	mergeButton.fire('click');
	assert.equal(view.getState().mergeTargetView, false);
	assert.equal(saves, 1);
});

// The related-notes view is reached from the vault health-check entry, so its
// tab title must name that context instead of looking like a second plugin.
test('related view title names the vault health-check context', () => {
	const { app } = makeApp([], {});
	const view = new RelatedNotesView({ app }, { groupingMode: 'none', hideCompliant: false }, async () => {});
	assert.equal(view.getDisplayText(), 'Vault 体检与清理：关联笔记整理');
});

// The health-check entry can run when the active file is not a Markdown note.
// The view must show a Chinese hint and keep a stable empty panel, not throw.
test('related view without a markdown source shows a Chinese hint', async () => {
	const { app } = makeApp([], {});
	const view = new RelatedNotesView({ app }, { groupingMode: 'none', hideCompliant: false }, async () => {});
	await view.setState({ sourcePaths: [] }, { history: false });
	assert.match(view.contentEl.querySelector('.related-operations-empty').textContent, /请先打开或选择 Markdown 笔记/);
	assert.equal(view.panel, undefined);
	await view.setState({ sourcePaths: ['missing.md'] }, { history: false });
	assert.match(view.contentEl.querySelector('.related-operations-empty').textContent, /请先打开或选择 Markdown 笔记/);
	assert.equal(view.panel, undefined);
});

// Opening from the health-check card passes the chosen notes as sourcePaths;
// every valid Markdown path must reach the panel, even when the order differs.
test('view state passes all health-check source paths into the panel', async () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t = file('dst/t.md');
	const { app } = makeApp([a, b, t], {
		'src/a.md': { 'dst/t.md': 1 },
		'src/b.md': { 'dst/t.md': 1 },
	});
	const view = new RelatedNotesView({ app }, { groupingMode: 'none', hideCompliant: false }, async () => {});
	await view.setState({ sourcePaths: ['src/b.md', 'src/a.md'], mergeTargetView: false }, { history: false });
	assert.deepEqual(view.panel.sourceFiles.map((item) => item.path), ['src/a.md', 'src/b.md']);
	assert.equal(view.contentEl.querySelector('.related-operations-selected-sources summary').textContent, '已选择源笔记（2）');
	assert.equal(view.contentEl.querySelectorAll('tr[data-related-path]').length, 2);
	assert.deepEqual(view.getState().sourcePaths, ['src/b.md', 'src/a.md']);
});

// The list display preferences are panel settings, not view state: changing
// them must write through to the settings object and request a save.
test('grouping and hide-compliant preferences persist to settings', () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const settings = { groupingMode: 'none', hideCompliant: false };
	let saves = 0;
	const { el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], {
		files: [a, t],
		settings,
		saveSettings: async () => { saves++; },
	});
	const grouping = el.querySelector('.related-operations-grouping-select');
	assert.equal(grouping.value, 'none');
	grouping.value = 'path';
	grouping.fire('change');
	assert.equal(settings.groupingMode, 'path');
	assert.equal(saves, 1);
	el.querySelector('.related-operations-hide-button').fire('click');
	assert.equal(settings.hideCompliant, true);
	assert.equal(saves, 2);
});

test('merged relation cell shows which source is outgoing and which is incoming', () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t = file('dst/t.md');
	const relatedNotes = [
		{ file: t, relation: 'both', sourceFile: a },
		{ file: t, relation: 'outgoing', sourceFile: b },
	];
	const { el } = panelFor(relatedNotes, [a, b]);
	el.querySelector('.related-operations-merge-button').fire('click');
	const cell = el.querySelector('.related-operations-relation');
	assert.match(cell.textContent, /a：出链 \+ 入链/);
	assert.match(cell.textContent, /b：出链/);
	assert.equal(el.querySelectorAll('th').length, 6, 'merging must not add a column');
});

test('moveFiles skips an existing same-name destination instead of renaming over it', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const occupant = file('archive/t.md');
	const { panel, renamed } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t, occupant] });
	const result = await panel.moveFiles('archive', [t]);
	assert.deepEqual(result.succeeded, []);
	assert.deepEqual(result.skipped, ['dst/t.md']);
	assert.deepEqual(renamed, []);
	assert.equal(t.path, 'dst/t.md');
	assert.equal(occupant.path, 'archive/t.md');
});

// Two selected notes can share a name from different folders. The first move
// creates the destination, so the second must be reported as skipped instead
// of overwriting it.
test('moveFiles skips the second of two selected files that share a name', async () => {
	const a = file('src/a.md');
	const x = file('x/dup.md');
	const y = file('y/dup.md');
	const { panel, renamed } = panelFor([], [a], { files: [a, x, y] });
	const result = await panel.moveFiles('archive', [x, y]);
	assert.deepEqual(result.succeeded, ['archive/dup.md']);
	assert.deepEqual(result.skipped, ['y/dup.md']);
	assert.deepEqual(renamed, [['x/dup.md', 'archive/dup.md']]);
	assert.equal(x.path, 'archive/dup.md');
	assert.equal(y.path, 'y/dup.md');
});

test('moveSelected reports same-name conflicts without calling renameFile', async () => {
	Notice.messages = [];
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const occupant = file('archive/t.md');
	const { panel, el, renamed } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t, occupant] });
	panel.selections.set('dst/t.md', true);
	const input = el.querySelector('.related-operations-target-folder');
	input.value = 'archive';
	input.fire('input');
	await panel.moveSelected();
	assert.deepEqual(renamed, []);
	assert.match(Notice.messages.at(-1), /存在冲突/);
	assert.equal(t.path, 'dst/t.md');
});

test('undoLastMove returns the last batch to the original paths', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { panel, renamed } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t] });
	await panel.moveFiles('archive', [t]);
	assert.equal(t.path, 'archive/t.md');
	await panel.undoLastMove();
	assert.equal(t.path, 'dst/t.md');
	assert.deepEqual(renamed, [['dst/t.md', 'archive/t.md'], ['archive/t.md', 'dst/t.md']]);
});

test('undoLastMove recreates the original folder before restoring', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { panel, renamed } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t] });
	await panel.moveFiles('archive', [t]);
	assert.equal(t.path, 'archive/t.md');
	assert.equal(panel.app.vault.getAllLoadedFiles().some((item) => item instanceof TFolder && item.path === 'dst'), false);
	await panel.undoLastMove();
	assert.equal(t.path, 'dst/t.md');
	assert.equal(panel.app.vault.getAllLoadedFiles().some((item) => item instanceof TFolder && item.path === 'dst'), true);
	assert.deepEqual(renamed, [['dst/t.md', 'archive/t.md'], ['archive/t.md', 'dst/t.md']]);
});

test('undoLastMove refuses to overwrite a file that reappeared at the original path', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { panel, renamed } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t] });
	await panel.moveFiles('archive', [t]);
	const occupant = file('dst/t.md');
	panel.app.vault.getAllLoadedFiles().push(occupant);
	await panel.undoLastMove();
	assert.equal(t.path, 'archive/t.md');
	assert.equal(occupant.path, 'dst/t.md');
	assert.deepEqual(renamed, [['dst/t.md', 'archive/t.md']]);
});

// Undo reuses the same case-insensitive path index as the move path: an
// occupant that differs only by case must still block the restore.
test('undoLastMove treats a case-variant occupant at the original path as a conflict', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { panel, renamed } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t] });
	await panel.moveFiles('archive', [t]);
	const occupant = file('DST/t.md');
	panel.app.vault.getAllLoadedFiles().push(occupant);
	Notice.messages = [];
	await panel.undoLastMove();
	assert.equal(t.path, 'archive/t.md');
	assert.equal(occupant.path, 'DST/t.md');
	assert.deepEqual(renamed, [['dst/t.md', 'archive/t.md']]);
	assert.match(Notice.messages.at(-1), /已跳过：1/);
});

// Reproduction: a successful move left the selected note's ORIGINAL path in
// the selection map (pruning used the post-rename path). Undo restores the file
// at that original path, so the stale entry made it look re-selected even
// though the user never checked it again.
test('move then undo leaves no stale selection key behind', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { panel, el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], {
		files: [a, t],
		resolvedLinks: { 'src/a.md': { 'dst/t.md': 1 } },
	});
	panel.selections.set('dst/t.md', true);
	const input = el.querySelector('.related-operations-target-folder');
	input.value = 'archive';
	input.fire('input');
	await moveSelectedConfirmed(panel);
	assert.equal(t.path, 'archive/t.md');
	assert.deepEqual([...panel.selections.keys()], [], '移动成功后不得保留旧路径勾选键');
	await panel.undoLastMove();
	assert.equal(t.path, 'dst/t.md');
	assert.deepEqual([...panel.selections.keys()], [], '撤销后不得复活旧勾选');
	const checkboxes = el.querySelectorAll('tr[data-related-path] input[type="checkbox"]');
	assert.equal(checkboxes.length, 1);
	assert.equal(checkboxes[0].checked, false, '还原的笔记应显示为未勾选');
});

// Regression guard: batch move must clear every moved key, and the selection
// summary, tab counts and rendered rows must all reflect the pruned list.
test('batch move clears every moved selection key and keeps counters consistent', async () => {
	const a = file('src/a.md');
	const t1 = file('dst/t1.md');
	const t2 = file('dst/t2.md');
	const relatedNotes = [t1, t2].map((target) => ({ file: target, relation: 'outgoing', sourceFile: a }));
	const { panel, el } = panelFor(relatedNotes, [a], { files: [a, t1, t2] });
	el.querySelector('.related-operations-select-all').fire('click');
	assert.equal(el.querySelector('.related-operations-selection-summary').textContent, '已选 2 篇（跨标签页）');
	const input = el.querySelector('.related-operations-target-folder');
	input.value = 'archive';
	input.fire('input');
	await moveSelectedConfirmed(panel);
	assert.deepEqual([...panel.selections.keys()], []);
	assert.equal(el.querySelector('.related-operations-selection-summary').textContent, '已选 0 篇（跨标签页）');
	assert.equal(el.querySelectorAll('tr[data-related-path]').length, 0);
	assert.equal(el.querySelector('.related-operations-tab').textContent, '出链 (0)');
	const selectAll = el.querySelector('.related-operations-select-all');
	assert.equal(selectAll.disabled, true);
	assert.equal(selectAll.textContent, '全选当前分组');
});

test('target folder input lists matching vault folders', () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const folders = [new TFolder('archive'), new TFolder('archive/2026'), new TFolder('notes')];
	const { el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t, ...folders] });
	const input = el.querySelector('.related-operations-target-folder');
	input.value = 'arch';
	input.fire('input');
	const suggestions = el.querySelectorAll('.related-operations-folder-suggestion').map((button) => button.textContent).sort();
	assert.deepEqual(suggestions, ['archive', 'archive/2026']);
});

// Rows after the first one in a source group do not create a source cell
// (rowSpan merges it into the first row), so the destination preview must be
// located from the end of the row instead of a fixed column index.
test('target folder changes refresh the preview on every grouped row', () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t1 = file('dst/t1.md');
	const t2 = file('dst/t2.md');
	const t3 = file('dst/t3.md');
	const relatedNotes = [
		{ file: t1, relation: 'outgoing', sourceFile: a },
		{ file: t2, relation: 'outgoing', sourceFile: a },
		{ file: t3, relation: 'outgoing', sourceFile: b },
	];
	const { el } = panelFor(relatedNotes, [a, b]);
	const rows = () => el.querySelectorAll('tr[data-related-path]');
	assert.equal(rows().length, 3);
	const previews = () => rows().map((row) => row.children.at(-1).textContent);
	assert.deepEqual(previews(), ['src/Pages/t1.md', 'src/Pages/t2.md', 'src/Pages/t3.md']);
	const input = el.querySelector('.related-operations-target-folder');
	input.value = 'archive';
	input.fire('input');
	assert.deepEqual(previews(), ['archive/t1.md', 'archive/t2.md', 'archive/t3.md']);
});

// Committing a target folder must re-apply the hide-compliant filter: typing
// only updates previews in place, but leaving the field (change) re-renders the
// list so notes already at the new target disappear and the count updates.
test('committing a target folder re-applies the hide-compliant filter', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], {
		files: [a, t],
		settings: { groupingMode: 'none', hideCompliant: true },
	});
	const rows = () => el.querySelectorAll('tr[data-related-path]');
	assert.equal(rows().length, 1);
	const input = el.querySelector('.related-operations-target-folder');
	input.value = 'dst';
	input.fire('input');
	assert.equal(rows().length, 1, '打字过程中先原位更新，不重建列表');
	assert.equal(rows()[0].hasClass('is-already-target'), true);
	input.fire('change');
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(rows().length, 0);
	assert.match(el.querySelector('.related-operations-empty').textContent, /已隐藏 1 条/);
	assert.match(el.querySelector('.related-operations-hide-button').textContent, /（1）/);
});

// Shortcut buttons are an immediate commit: they must re-render so a note that
// becomes movable under the new target is actually shown.
test('target folder shortcuts re-apply the hide-compliant filter immediately', () => {
	const a = file('src/a.md');
	const t = file('src/Pages/t.md');
	const { el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], {
		files: [a, t],
		settings: { groupingMode: 'none', hideCompliant: true },
	});
	const rows = () => el.querySelectorAll('tr[data-related-path]');
	assert.equal(rows().length, 0, '默认目标 src/Pages 下该笔记应被隐藏');
	const shortcut = el.querySelectorAll('.related-operations-target-shortcuts button').find((button) => button.textContent === '当前目录');
	shortcut.fire('click');
	assert.equal(rows().length, 1);
	assert.equal(rows()[0].dataset.relatedPath, 'src/Pages/t.md');
});

test('large multi-source batch keeps dedupe, select-all, merge and move list correct', async (t) => {
	const sources = Array.from({ length: 100 }, (_, i) => file(`src/source-${i}.md`));
	const targets = Array.from({ length: 500 }, (_, i) => file(`dst/target-${i}.md`));
	const relatedNotes = [];
	for (let i = 0; i < sources.length; i++) {
		for (let k = 0; k < 20; k++) {
			relatedNotes.push({ file: targets[(i * 5 + k) % targets.length], relation: 'outgoing', sourceFile: sources[i] });
		}
	}
	const renderStart = performance.now();
	const { panel, el, renamed } = panelFor(relatedNotes, sources, { files: [...sources, ...targets] });
	const renderMs = performance.now() - renderStart;
	assert.equal(el.querySelectorAll('.related-operations-tab')[0].textContent, '出链 (500)');
	el.querySelector('.related-operations-select-all-action').fire('click');
	assert.equal([...panel.selections.values()].filter(Boolean).length, 500);
	const mergeStart = performance.now();
	el.querySelector('.related-operations-merge-button').fire('click');
	const mergeMs = performance.now() - mergeStart;
	assert.equal(el.querySelectorAll('tr[data-related-path]').length, 500);
	const previewStart = performance.now();
	const targetInput = el.querySelector('.related-operations-target-folder');
	targetInput.value = 'archive';
	targetInput.fire('input');
	const previewMs = performance.now() - previewStart;
	const stalePreviews = el.querySelectorAll('tr[data-related-path]').filter((row) => !row.children.at(-1).textContent.startsWith('archive/'));
	assert.equal(stalePreviews.length, 0);
	const uniqueTargets = [...new Map(relatedNotes.map((note) => [note.file.path, note.file])).values()];
	const moveStart = performance.now();
	const result = await panel.moveFiles('archive', [...uniqueTargets, ...uniqueTargets]);
	const moveMs = performance.now() - moveStart;
	assert.equal(result.succeeded.length, 500);
	assert.equal(renamed.length, 500);
	assert.ok(renderMs < 5000 && mergeMs < 5000 && moveMs < 5000);
	assert.ok(previewMs < 5000);
	t.diagnostic(`large batch: render=${renderMs.toFixed(1)}ms merge=${mergeMs.toFixed(1)}ms move=${moveMs.toFixed(1)}ms preview=${previewMs.toFixed(1)}ms`);
});

// An empty query is a folder picker, not a no-op: it lists every vault folder
// in sorted order and never leaks file entries into the suggestions.
test('folder suggestions list every vault folder sorted and skip files', () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const folders = [new TFolder('zeta'), new TFolder('archive/2026'), new TFolder('archive')];
	const { el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], {
		files: [a, t, new TFile('architecture.md'), ...folders],
	});
	const input = el.querySelector('.related-operations-target-folder');
	input.value = '';
	input.fire('input');
	const labels = el.querySelectorAll('.related-operations-folder-suggestion').map((button) => button.textContent);
	assert.deepEqual(labels, ['archive', 'archive/2026', 'zeta']);
});

// Vault paths are matched case-insensitively so the typed folder still finds
// the real one on case-sensitive editors.
test('folder suggestions match case-insensitively', () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const folders = [new TFolder('archive'), new TFolder('archive/2026'), new TFolder('notes')];
	const { el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t, ...folders] });
	const input = el.querySelector('.related-operations-target-folder');
	input.value = 'ARCH';
	input.fire('input');
	const labels = el.querySelectorAll('.related-operations-folder-suggestion').map((button) => button.textContent);
	assert.deepEqual(labels, ['archive', 'archive/2026']);
});

// Clicking a suggestion is a full input commit: it writes the value, fires the
// input event (so previews recompute) and hides the suggestion popup.
test('clicking a folder suggestion fills the input and refreshes the preview', () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const folders = [new TFolder('archive'), new TFolder('archive/2026')];
	const { el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t, ...folders] });
	const previews = () => el.querySelectorAll('tr[data-related-path]').map((row) => row.children.at(-1).textContent);
	assert.deepEqual(previews(), ['src/Pages/t.md']);
	const input = el.querySelector('.related-operations-target-folder');
	input.value = 'archive';
	input.fire('input');
	const button = el.querySelectorAll('.related-operations-folder-suggestion').find((item) => item.textContent === 'archive/2026');
	const popup = button.parent;
	button.fire('click');
	assert.equal(input.value, 'archive/2026');
	assert.deepEqual(previews(), ['archive/2026/t.md']);
	assert.equal(popup.hasClass('is-visible'), false);
});

// Vault paths collide case-insensitively in practice. A file already living at
// Archive/T.md must block a move to archive/t.md instead of overwriting it.
test('moveFiles treats a case-variant destination as an existing conflict', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const occupant = file('Archive/T.md');
	const { panel, renamed } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t, occupant] });
	const result = await panel.moveFiles('archive', [t]);
	assert.deepEqual(result.succeeded, []);
	assert.deepEqual(result.skipped, ['dst/t.md']);
	assert.deepEqual(renamed, []);
	assert.equal(t.path, 'dst/t.md');
	assert.equal(occupant.path, 'Archive/T.md');
});

// Typing a note path where a folder is expected must fail loudly, not create a
// half-made folder chain and rename the note into it.
test('moveFiles fails cleanly when the target path is an existing file', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { panel, renamed } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t] });
	const result = await panel.moveFiles('dst/t.md', [t]);
	assert.deepEqual(result.succeeded, []);
	assert.deepEqual(result.failed, [{
		path: 'dst/t.md',
		reason: '目标路径中的「dst/t.md」是文件',
		kind: 'target-is-file',
		nextStep: '请改用其他文件夹名，或先把该文件移走。',
	}]);
	assert.deepEqual(renamed, []);
	assert.equal(t.path, 'dst/t.md');
});

// A vanished moved file is a partial undo failure: the restored notes must be
// reported, and the failed record kept so the user can retry later.
test('undoLastMove keeps failed restores retryable and reports the split', async () => {
	const a = file('src/a.md');
	const t1 = file('dst/t1.md');
	const t2 = file('dst/t2.md');
	const { panel } = panelFor([], [a], { files: [a, t1, t2] });
	await panel.moveFiles('archive', [t1, t2]);
	const files = panel.app.vault.getAllLoadedFiles();
	files.splice(files.indexOf(t2), 1);
	Notice.messages = [];
	await panel.undoLastMove();
	const notice = Notice.messages.at(-1);
	assert.match(notice, /已撤销：1/);
	assert.match(notice, /失败：1/);
	assert.match(notice, /archive\/t2\.md/);
	assert.deepEqual(panel.lastMove, [{ from: 'dst/t2.md', to: 'archive/t2.md' }]);
});

// A target folder that does not exist yet (including nested segments) must be
// created segment by segment before the note is renamed into it.
test('moveFiles creates a missing nested target folder before renaming', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { panel, renamed } = panelFor([], [a], { files: [a, t] });
	const result = await panel.moveFiles('archive/2026/q4', [t]);
	assert.deepEqual(result.succeeded, ['archive/2026/q4/t.md']);
	assert.deepEqual(result.failed, []);
	const folders = panel.app.vault.getAllLoadedFiles().filter((item) => item instanceof TFolder).map((folder) => folder.path);
	assert.deepEqual(folders.sort(), ['archive', 'archive/2026', 'archive/2026/q4']);
	assert.deepEqual(renamed, [['dst/t.md', 'archive/2026/q4/t.md']]);
	assert.equal(t.path, 'archive/2026/q4/t.md');
});

// Regression: clicking a related note name is the only "jump to file" affordance
// in the list. It must open that exact file in a new tab, not just the source.
test('clicking a related note name opens that file in a new tab', () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { el, opened } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t] });
	const link = el.querySelector('tr[data-related-path] a');
	assert.equal(link.textContent, 't');
	link.fire('click');
	assert.deepEqual(opened, [['dst/t.md', 'src/a.md', 'tab']]);
});

// Restart persistence: display preferences are stored in settings, so a newly
// created view must render with the saved grouping and hide state instead of
// falling back to defaults.
test('grouping and hide preferences survive recreating the view from saved settings', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const settings = { groupingMode: 'none', hideCompliant: false };
	let saves = 0;
	const { app, el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], {
		files: [a, t],
		resolvedLinks: { 'src/a.md': { 'dst/t.md': 1 } },
		settings,
		saveSettings: async () => { saves++; },
	});
	const grouping = el.querySelector('.related-operations-grouping-select');
	assert.equal(grouping.value, 'none');
	grouping.value = 'path';
	grouping.fire('change');
	el.querySelector('.related-operations-hide-button').fire('click');
	assert.equal(settings.groupingMode, 'path');
	assert.equal(settings.hideCompliant, true);
	assert.equal(saves, 2);

	const reloaded = JSON.parse(JSON.stringify(settings));
	const view = new RelatedNotesView({ app }, reloaded, async () => {});
	await view.setState({ sourcePaths: ['src/a.md'], mergeTargetView: false }, { history: false });
	assert.equal(view.contentEl.querySelector('.related-operations-grouping-select').value, 'path');
	assert.equal(view.contentEl.querySelector('.related-operations-hide-button').getAttribute('aria-pressed'), 'true');
	assert.equal(view.contentEl.querySelectorAll('tr[data-related-path]').length, 1, '源笔记状态也必须随视图状态恢复');
});

// Reopening the same view or switching its source must recompute relations from
// the current metadata cache; an already-open leaf must never show stale rows.
test('reopening or switching sources rescans instead of reusing stale relations', async () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const old = file('dst/old.md');
	const fresh = file('dst/new.md');
	const fromB = file('src/from-b.md');
	const { app } = makeApp([a, b, old, fresh, fromB], {
		'src/a.md': { 'dst/old.md': 1 },
		'src/b.md': { 'src/from-b.md': 1 },
	});
	const view = new RelatedNotesView({ app }, { groupingMode: 'none', hideCompliant: false }, async () => {});
	const paths = () => view.contentEl.querySelectorAll('tr[data-related-path]').map((row) => row.dataset.relatedPath);
	await view.setState({ sourcePaths: ['src/a.md'], mergeTargetView: false }, { history: false });
	assert.deepEqual(paths(), ['dst/old.md']);
	app.metadataCache.resolvedLinks['src/a.md'] = { 'dst/new.md': 1 };
	await view.setState({ sourcePaths: ['src/a.md'], mergeTargetView: false }, { history: false });
	assert.deepEqual(paths(), ['dst/new.md'], '同一来源重新打开时必须重新扫描');
	await view.setState({ sourcePaths: ['src/b.md'], mergeTargetView: false }, { history: false });
	assert.deepEqual(paths(), ['src/from-b.md'], '切换源笔记时必须换成新来源的关联结果');
});

// A view that stays open must also track metadata changes, otherwise edits in a
// split pane leave the relation list stale until the command is run again.
test('metadata changes refresh an open view without resetting the target folder', async () => {
	const a = file('src/a.md');
	const old = file('dst/old.md');
	const fresh = file('dst/new.md');
	const changes = [];
	const vaultHandlers = {};
	const files = [a, old, fresh];
	const app = {
		metadataCache: {
			resolvedLinks: { 'src/a.md': { 'dst/old.md': 1 } },
			getFileCache: () => ({}),
			on: (event, callback) => { changes.push(callback); return callback; },
		},
		vault: {
			getAbstractFileByPath: (path) => files.find((item) => item.path === path) ?? null,
			getAllLoadedFiles: () => files,
			createFolder: async () => {},
			on: (event, callback) => { vaultHandlers[event] = callback; return callback; },
		},
		fileManager: { renameFile: async () => {} },
		workspace: { openLinkText: async () => {}, requestSaveLayout: async () => {} },
	};
	const view = new RelatedNotesView({ app }, { groupingMode: 'none', hideCompliant: false }, async () => {});
	await view.onOpen();
	await view.setState({ sourcePaths: ['src/a.md'], mergeTargetView: false }, { history: false });
	const rows = () => view.contentEl.querySelectorAll('tr[data-related-path]').map((row) => row.dataset.relatedPath);
	assert.deepEqual(rows(), ['dst/old.md']);
	const input = view.contentEl.querySelector('.related-operations-target-folder');
	input.value = 'archive';
	input.fire('input');
	view.contentEl.querySelector('.related-operations-table-scroll').scrollTop = 120;
	app.metadataCache.resolvedLinks['src/a.md'] = { 'dst/new.md': 1 };
	changes[0](a);
	await new Promise((resolve) => setTimeout(resolve, 450));
	assert.deepEqual(rows(), ['dst/new.md']);
	assert.equal(view.contentEl.querySelector('.related-operations-target-folder').value, 'archive', '自动刷新不得重置目标文件夹');
	assert.equal(view.contentEl.querySelector('.related-operations-table-scroll').scrollTop, 120, '自动刷新应保留滚动位置');
	changes[0](file('other/unrelated.md'));
	await new Promise((resolve) => setTimeout(resolve, 450));
	assert.deepEqual(rows(), ['dst/new.md'], '无关笔记变化不应触发重新扫描');
	files.splice(files.indexOf(fresh), 1);
	delete app.metadataCache.resolvedLinks['src/a.md'];
	vaultHandlers.delete(fresh);
	await new Promise((resolve) => setTimeout(resolve, 450));
	assert.deepEqual(rows(), [], '删除关联笔记后打开中的视图应自动刷新');
	await view.onClose();
});

// Vault paths may contain Chinese characters and spaces; every segment must be
// created verbatim before the rename so the note lands in the real folder.
test('moveFiles creates Chinese and spaced folder segments before renaming', async () => {
	const a = file('src/a.md');
	const t = new TFile('dst/设计 说明.md');
	const { panel, renamed } = panelFor([], [a], { files: [a, t] });
	const result = await panel.moveFiles('归档/设计 文档', [t]);
	assert.deepEqual(result.succeeded, ['归档/设计 文档/设计 说明.md']);
	assert.deepEqual(result.failed, []);
	const folders = panel.app.vault.getAllLoadedFiles().filter((item) => item instanceof TFolder).map((folder) => folder.path);
	assert.deepEqual(folders.sort(), ['归档', '归档/设计 文档'].sort());
	assert.deepEqual(renamed, [['dst/设计 说明.md', '归档/设计 文档/设计 说明.md']]);
	assert.equal(t.path, '归档/设计 文档/设计 说明.md');
});

// A file in the middle of the target chain must abort the whole batch without
// renaming anything; reporting the target folder as failed is what the user sees.
test('moveFiles fails cleanly when a nested target segment is an existing file', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const blocker = file('archive/2026');
	const { panel, renamed } = panelFor([], [a], { files: [a, t, blocker] });
	const result = await panel.moveFiles('archive/2026/q4', [t]);
	assert.deepEqual(result.succeeded, []);
	assert.deepEqual(result.moved, []);
	assert.deepEqual(result.failed, [{
		path: 'archive/2026/q4',
		reason: '目标路径中的「archive/2026」是文件',
		kind: 'target-is-file',
		nextStep: '请改用其他文件夹名，或先把该文件移走。',
	}]);
	assert.deepEqual(renamed, []);
	assert.equal(t.path, 'dst/t.md');
});

// If the note is renamed outside the plugin after a move, undo cannot find the
// destination anymore. It must report the failure and keep the record retryable.
test('undoLastMove reports a note renamed outside the plugin and keeps the record', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { panel, renamed } = panelFor([], [a], { files: [a, t] });
	await panel.moveFiles('archive', [t]);
	t.path = 'archive/t-renamed.md';
	Notice.messages = [];
	await panel.undoLastMove();
	const notice = Notice.messages.at(-1);
	assert.match(notice, /已撤销：0/);
	assert.match(notice, /失败：1/);
	assert.match(notice, /文件已不存在或已被重命名/);
	assert.deepEqual(panel.lastMove, [{ from: 'dst/t.md', to: 'archive/t.md' }]);
	assert.equal(t.path, 'archive/t-renamed.md');
	assert.deepEqual(renamed, [['dst/t.md', 'archive/t.md']]);
});

// Undo restores the path with a rename. Content edited at the destination while
// the note was moved must survive that restore untouched.
test('undoLastMove restores the path without discarding external edits', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	t.content = 'original';
	const { panel } = panelFor([], [a], { files: [a, t] });
	await panel.moveFiles('archive', [t]);
	t.content = 'edited while moved';
	await panel.undoLastMove();
	assert.equal(t.path, 'dst/t.md');
	assert.equal(t.content, 'edited while moved');
	assert.deepEqual(panel.lastMove, []);
});

// One rename failing mid-batch must not stop the rest. The reported split and
// the undo records must describe exactly the files that actually moved.
test('a failed rename in a batch keeps results and undo records consistent', async () => {
	const a = file('src/a.md');
	const good = file('dst/good.md');
	const bad = file('dst/bad.md');
	const later = file('dst/later.md');
	const { panel, renamed } = panelFor([], [a], { files: [a, good, bad, later] });
	const rename = panel.app.fileManager.renameFile;
	panel.app.fileManager.renameFile = async (file, dest) => {
		if (file.path === 'dst/bad.md') throw new Error('磁盘已满');
		await rename(file, dest);
	};
	const result = await panel.moveFiles('archive', [good, bad, later]);
	assert.deepEqual(result.succeeded, ['archive/good.md', 'archive/later.md']);
	assert.deepEqual(result.failed, [{
		path: 'dst/bad.md',
		reason: '磁盘已满',
		kind: 'other',
		nextStep: '请稍后重试；若持续失败，请检查目标文件夹是否可写。',
	}]);
	assert.deepEqual(result.skipped, []);
	assert.deepEqual(result.moved, [
		{ from: 'dst/good.md', to: 'archive/good.md' },
		{ from: 'dst/later.md', to: 'archive/later.md' },
	]);
	assert.equal(bad.path, 'dst/bad.md');
	assert.deepEqual(panel.lastMove, result.moved);
	assert.deepEqual(renamed, [['dst/good.md', 'archive/good.md'], ['dst/later.md', 'archive/later.md']]);
});

// A partial failure must leave the successful moves undoable, and undo must put
// every moved note back while leaving the failed note untouched.
test('partial batch failure keeps successes undoable and restores them completely', async () => {
	const a = file('src/a.md');
	const good = file('dst/good.md');
	const bad = file('dst/bad.md');
	const relatedNotes = [good, bad].map((target) => ({ file: target, relation: 'outgoing', sourceFile: a }));
	const { panel, el, renamed } = panelFor(relatedNotes, [a], {
		files: [a, good, bad],
		resolvedLinks: { 'src/a.md': { 'dst/good.md': 1, 'dst/bad.md': 1 } },
	});
	panel.selections.set('dst/good.md', true);
	panel.selections.set('dst/bad.md', true);
	const input = el.querySelector('.related-operations-target-folder');
	input.value = 'archive';
	input.fire('input');
	const rename = panel.app.fileManager.renameFile;
	panel.app.fileManager.renameFile = async (file, dest) => {
		if (file.path === 'dst/bad.md') throw new Error('locked');
		await rename(file, dest);
	};
	Notice.messages = [];
	await moveSelectedConfirmed(panel);
	assert.equal(good.path, 'archive/good.md');
	assert.equal(bad.path, 'dst/bad.md');
	assert.deepEqual(renamed, [['dst/good.md', 'archive/good.md']]);
	assert.deepEqual(panel.lastMove, [{ from: 'dst/good.md', to: 'archive/good.md' }]);
	assert.match(Notice.messages.at(-1), /已移动：1/);
	assert.match(Notice.messages.at(-1), /失败：1/);
	assert.deepEqual(el.querySelectorAll('tr[data-related-path]').map((row) => row.dataset.relatedPath), ['dst/bad.md']);

	await panel.undoLastMove();
	assert.equal(good.path, 'dst/good.md');
	assert.equal(bad.path, 'dst/bad.md');
	assert.deepEqual(panel.lastMove, []);
	assert.deepEqual(
		el.querySelectorAll('tr[data-related-path]').map((row) => row.dataset.relatedPath).sort(),
		['dst/bad.md', 'dst/good.md'],
	);
});

// A stale selection can survive while the note is already at the target (for
// example after an external move). It must not trigger a pointless rename.
test('moveSelected ignores a stale selection already at the target folder', async () => {
	Notice.messages = [];
	const a = file('src/a.md');
	const t = file('src/Pages/t.md');
	const { panel, el, renamed } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], {
		files: [a, t],
		settings: { groupingMode: 'none', hideCompliant: false },
	});
	const input = el.querySelector('.related-operations-target-folder');
	input.value = 'src/Pages';
	input.fire('input');
	// The input handler prunes at-target selections; set one afterwards to
	// simulate a selection left over from another frame.
	panel.selections.set('src/Pages/t.md', true);
	globalThis.__openModals = [];
	await panel.moveSelected();
	assert.equal(globalThis.__openModals.length, 0);
	assert.deepEqual(renamed, []);
	assert.deepEqual(panel.lastMove, []);
	assert.match(Notice.messages.at(-1), /已经在目标文件夹|存在冲突/);
	assert.equal(t.path, 'src/Pages/t.md');
});

// The confirmation must say what will happen: how many notes, the exact target,
// whether the folder exists or will be created, and that the move is undoable.
test('move confirmation names the count, target and folder creation state', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const existing = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], {
		files: [a, t, new TFolder('archive')],
	});
	existing.panel.selections.set('dst/t.md', true);
	const existingInput = existing.el.querySelector('.related-operations-target-folder');
	existingInput.value = 'archive';
	existingInput.fire('input');
	const opened = await openMoveConfirmation(existing.panel);
	const existingText = opened.modal.contentEl.textContent;
	assert.match(existingText, /即将把 1 篇笔记移动到/);
	assert.match(existingText, /archive/);
	assert.match(existingText, /目标文件夹已存在/);
	assert.match(existingText, /撤销本次移动/);
	await opened.close();

	const t2 = file('dst/t2.md');
	const missing = panelFor([{ file: t2, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t2] });
	missing.panel.selections.set('dst/t2.md', true);
	const missingInput = missing.el.querySelector('.related-operations-target-folder');
	missingInput.value = 'archive/2026';
	missingInput.fire('input');
	const created = await openMoveConfirmation(missing.panel);
	assert.match(created.modal.contentEl.textContent, /尚不存在.*自动创建/);
	await created.close();
});

// Conflicts are skipped before the modal, so the modal must explain why and what
// the user can do about the notes that will not move.
test('move confirmation explains same-name conflicts and the next step', async () => {
	const a = file('src/a.md');
	const movable = file('dst/keep.md');
	const conflicted = file('dst/hold.md');
	const occupant = file('archive/hold.md');
	const { panel, el } = panelFor([
		{ file: movable, relation: 'outgoing', sourceFile: a },
		{ file: conflicted, relation: 'outgoing', sourceFile: a },
	], [a], { files: [a, movable, conflicted, occupant] });
	panel.selections.set('dst/keep.md', true);
	panel.selections.set('dst/hold.md', true);
	const input = el.querySelector('.related-operations-target-folder');
	input.value = 'archive';
	input.fire('input');
	const opened = await openMoveConfirmation(panel);
	const text = opened.modal.contentEl.textContent;
	assert.match(text, /1 篇笔记因目标位置已有同名笔记/);
	assert.match(text, /改用其他目标文件夹|先重命名/);
	await opened.close();
});

// A target chain blocked by a file must be rejected before the confirmation
// dialog, with a concrete next step instead of a generic move failure.
test('moveSelected rejects a target chain blocked by a file before confirming', async () => {
	Notice.messages = [];
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const blocker = file('archive/2026');
	const { panel, el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], {
		files: [a, t, new TFolder('archive'), blocker],
	});
	panel.selections.set('dst/t.md', true);
	const input = el.querySelector('.related-operations-target-folder');
	input.value = 'archive/2026/q4';
	input.fire('input');
	globalThis.__openModals = [];
	await panel.moveSelected();
	assert.equal(globalThis.__openModals.length, 0, '目标被文件阻断时不应弹出确认框');
	assert.match(Notice.messages.at(-1), /是文件/);
	assert.match(Notice.messages.at(-1), /其他文件夹名|先把该文件移走/);
	assert.equal(t.path, 'dst/t.md');
	assert.deepEqual(panel.lastMove, []);
});

// Rename failures are categorized so the user can act: permission errors point
// at folder permissions, a race with an existing file points at the conflict.
test('rename failures distinguish permission errors from existing destinations', async () => {
	const a = file('src/a.md');
	const denied = file('dst/denied.md');
	const race = file('dst/race.md');
	const { panel } = panelFor([], [a], { files: [a, denied, race] });
	const rename = panel.app.fileManager.renameFile;
	panel.app.fileManager.renameFile = async (file, dest) => {
		if (file.path === 'dst/denied.md') throw new Error('EPERM: operation not permitted');
		if (file.path === 'dst/race.md') throw new Error('EEXIST: file already exists');
		await rename(file, dest);
	};
	const result = await panel.moveFiles('archive', [denied, race]);
	assert.deepEqual(result.failed, [
		{
			path: 'dst/denied.md',
			reason: '没有目标文件夹的写入权限',
			kind: 'permission',
			nextStep: '请检查文件夹权限后重试，或改用其他文件夹。',
		},
		{
			path: 'dst/race.md',
			reason: '目标位置已有同名笔记',
			kind: 'exists',
			nextStep: '请改用其他目标文件夹，或先重命名冲突笔记。',
		},
	]);
	assert.equal(denied.path, 'dst/denied.md');
	assert.equal(race.path, 'dst/race.md');
});

// Keyboard users cannot reach a bare <a> without href. The note-name links must
// expose button semantics and activate on Enter or Space, for both the related
// note and the source note shown in the header.
test('related note and source links are keyboard activatable', () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { el, opened } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t] });
	const noteLink = el.querySelector('tr[data-related-path] a');
	const sourceLink = el.querySelector('.related-operations-source-link');
	for (const link of [noteLink, sourceLink]) {
		assert.equal(link.getAttribute('role'), 'button');
		assert.equal(link.getAttribute('tabindex'), '0');
	}
	noteLink.fire('keydown', { key: 'Enter' });
	noteLink.fire('keydown', { key: ' ' });
	noteLink.fire('keydown', { key: 'a' });
	sourceLink.fire('keydown', { key: 'Enter' });
	assert.deepEqual(opened, [
		['dst/t.md', 'src/a.md', 'tab'],
		['dst/t.md', 'src/a.md', 'tab'],
		['src/a.md', 'src/a.md', 'tab'],
	]);
});

// Single-source rows have no source column, so the relation cell must say which
// note the direction refers to instead of only "出链/入链".
test('single-source relation cells explain which note the relation points at', () => {
	const a = file('src/a.md');
	const relationText = (relation, tab) => {
		const t = file('dst/t.md');
		const { el } = panelFor([{ file: t, relation, sourceFile: a }], [a]);
		if (tab) {
			el.querySelectorAll('.related-operations-tab').find((item) => item.textContent.startsWith(tab)).fire('click');
		}
		const row = el.querySelector('tr[data-related-path]');
		return row.children[3].textContent;
	};
	assert.equal(relationText('outgoing'), '出链自 a');
	assert.equal(relationText('incoming', '入链'), 'a 的入链');
	assert.equal(relationText('both'), '与 a 双向链接');
});

// The relation column is narrow. Long source names must be cut with an ellipsis
// in the visible text while the title keeps the complete explanation.
test('long relation explanations are truncated with the full text in the title', () => {
	const a = new TFile('src/这是一个特别长的源笔记名称用于验证关系文案截断效果.md');
	const t = file('dst/t.md');
	const { el } = panelFor([{ file: t, relation: 'incoming', sourceFile: a }], [a]);
	const tab = el.querySelectorAll('.related-operations-tab').find((item) => item.textContent.startsWith('入链'));
	tab.fire('click');
	const cell = el.querySelector('tr[data-related-path]').children[3];
	const full = `${a.basename} 的入链`;
	assert.ok([...cell.textContent].length <= 24, '可见关系文案不得超过 24 个字符');
	assert.ok(cell.textContent.endsWith('…'), '截断后应带省略号');
	assert.equal(cell.title, full, '完整说明应放在 title 中');
});

// With no relations at all the panel must explain what was checked, not just
// show a bare "empty" line, and the bulk actions must stay disabled.
test('empty related list explains that no outgoing or incoming links exist', () => {
	const a = file('src/a.md');
	const { el } = panelFor([], [a], { files: [a] });
	const empty = el.querySelector('.related-operations-empty');
	assert.match(empty.textContent, /没有出链/);
	assert.match(empty.textContent, /没有其他笔记链接/);
	assert.equal(el.querySelectorAll('tr[data-related-path]').length, 0);
	assert.equal(el.querySelector('.related-operations-select-all').disabled, true);
	assert.equal(el.querySelector('.related-operations-actions button').disabled, false, '返回按钮不应被禁用');
});

// Only the active tab can be empty while other tabs still have rows. The empty
// state must then point at the other tabs instead of claiming the note has no
// relations at all.
test('an empty tab points to the other tabs when relations exist elsewhere', () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t] });
	el.querySelectorAll('.related-operations-tab').find((tab) => tab.textContent.startsWith('入链')).fire('click');
	const empty = el.querySelector('.related-operations-empty');
	assert.match(empty.textContent, /切换其他标签页/);
	assert.doesNotMatch(empty.textContent, /没有出链/);
});

// A hub note can list 1000 relations. Rendering must stay responsive, use the
// scroll container, and keep select-all working on the whole group.
test('renders 1000 related notes with a scroll container and working select-all', (t) => {
	const a = file('src/a.md');
	const targets = Array.from({ length: 1000 }, (_, index) => file(`dst/t-${index}.md`));
	const relatedNotes = targets.map((target) => ({ file: target, relation: 'outgoing', sourceFile: a }));
	const start = performance.now();
	const { panel, el } = panelFor(relatedNotes, [a], {
		files: [a, ...targets],
		settings: { groupingMode: 'none', hideCompliant: false },
	});
	const renderMs = performance.now() - start;
	assert.equal(el.querySelectorAll('tr[data-related-path]').length, 1000);
	assert.ok(el.querySelector('.related-operations-table-scroll'), '大列表应放在可滚动容器中');
	el.querySelector('.related-operations-select-all').fire('click');
	assert.equal([...panel.selections.values()].filter(Boolean).length, 1000);
	assert.ok(renderMs < 5000, `1000 行渲染应保持响应，实际 ${renderMs.toFixed(1)}ms`);
	t.diagnostic(`1000 rows: render=${renderMs.toFixed(1)}ms`);
});

// Changing grouping is an immediate display action: rows must regroup before
// the next open, and the choice must be written through to settings.
test('changing grouping re-renders immediately and persists to settings', () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t1 = file('dst/t1.md');
	const t2 = file('dst/t2.md');
	const settings = { groupingMode: 'none', hideCompliant: false };
	let saves = 0;
	const { el } = panelFor([
		{ file: t1, relation: 'outgoing', sourceFile: a },
		{ file: t2, relation: 'outgoing', sourceFile: b },
	], [a, b], {
		files: [a, b, t1, t2],
		settings,
		saveSettings: async () => { saves++; },
	});
	const groupRows = () => el.querySelectorAll('.related-operations-path-group');
	assert.equal(groupRows().length, 0);
	const grouping = el.querySelector('.related-operations-grouping-select');
	grouping.value = 'source';
	grouping.fire('change');
	assert.deepEqual(groupRows().map((row) => row.textContent), ['src/a.md', 'src/b.md']);
	assert.equal(settings.groupingMode, 'source');
	assert.equal(saves, 1);
});

// Grouping is only a display change. Selections are keyed by path, so the same
// notes must stay checked and counted after switching source/path grouping.
test('grouping switches keep selections, summary and select-all consistent', () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t1 = file('dst/t1.md');
	const t2 = file('dst/t2.md');
	const { el } = panelFor([
		{ file: t1, relation: 'outgoing', sourceFile: a },
		{ file: t2, relation: 'outgoing', sourceFile: b },
	], [a, b], {
		files: [a, b, t1, t2],
		settings: { groupingMode: 'none', hideCompliant: false },
	});
	const summary = () => el.querySelector('.related-operations-selection-summary').textContent;
	const rowFor = (path) => el.querySelectorAll('tr[data-related-path]').find((row) => row.dataset.relatedPath === path);
	const boxFor = (path) => rowFor(path).querySelector('input[type="checkbox"]');
	boxFor('dst/t1.md').checked = true;
	boxFor('dst/t1.md').fire('change');
	assert.equal(summary(), '已选 1 篇（跨标签页）：t1');

	let grouping = el.querySelector('.related-operations-grouping-select');
	grouping.value = 'source';
	grouping.fire('change');
	assert.equal(boxFor('dst/t1.md').checked, true);
	assert.equal(boxFor('dst/t2.md').checked, false);
	assert.equal(summary(), '已选 1 篇（跨标签页）：t1');
	el.querySelector('.related-operations-select-all').fire('click');
	assert.equal(boxFor('dst/t1.md').checked, true);
	assert.equal(boxFor('dst/t2.md').checked, true);
	assert.equal(summary(), '已选 2 篇（跨标签页）');

	grouping = el.querySelector('.related-operations-grouping-select');
	grouping.value = 'path';
	grouping.fire('change');
	assert.equal(boxFor('dst/t1.md').checked, true);
	assert.equal(boxFor('dst/t2.md').checked, true);
	assert.equal(summary(), '已选 2 篇（跨标签页）');
});

// In non-merged mode one target can have one row per source. The hide button
// must count the rows it will reveal, not the deduped target paths.
test('hidden compliant count matches rows in per-source view and targets when merged', () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t = file('src/Pages/t.md');
	const { el } = panelFor([
		{ file: t, relation: 'outgoing', sourceFile: a },
		{ file: t, relation: 'outgoing', sourceFile: b },
	], [a, b], {
		files: [a, b, t],
		settings: { groupingMode: 'none', hideCompliant: true },
	});
	const rows = () => el.querySelectorAll('tr[data-related-path]');
	const hide = () => el.querySelector('.related-operations-hide-button');
	assert.equal(rows().length, 0);
	assert.match(hide().textContent, /（2）/);
	assert.match(el.querySelector('.related-operations-empty').textContent, /已隐藏 2 条/);
	hide().fire('click');
	assert.equal(rows().length, 2);

	el.querySelector('.related-operations-merge-button').fire('click');
	assert.match(hide().textContent, /（1）/);
	hide().fire('click');
	assert.equal(rows().length, 0);
	assert.match(el.querySelector('.related-operations-empty').textContent, /已隐藏 1 条/);
});

// A refresh may add or remove relations, but a selection whose note still
// exists must stay checked and counted.
test('refresh keeps selections for notes that still exist', () => {
	const a = file('src/a.md');
	const keep = file('dst/keep.md');
	const added = file('dst/added.md');
	const { panel, el, app } = panelFor([{ file: keep, relation: 'outgoing', sourceFile: a }], [a], {
		files: [a, keep, added],
		resolvedLinks: { 'src/a.md': { 'dst/keep.md': 1 } },
		settings: { groupingMode: 'none', hideCompliant: false },
	});
	const box = () => el.querySelectorAll('tr[data-related-path]').find((row) => row.dataset.relatedPath === 'dst/keep.md').querySelector('input[type="checkbox"]');
	box().checked = true;
	box().fire('change');
	assert.equal([...panel.selections.entries()].filter(([, on]) => on).length, 1);
	app.metadataCache.resolvedLinks['src/a.md'] = { 'dst/keep.md': 1, 'dst/added.md': 1 };
	panel.refreshRelations();
	assert.equal(box().checked, true);
	assert.equal(el.querySelector('.related-operations-selection-summary').textContent, '已选 1 篇（跨标签页）：keep');
	assert.ok(el.querySelectorAll('tr[data-related-path]').some((row) => row.dataset.relatedPath === 'dst/added.md'));
});

// Moving a note up into its parent folder and then down into a child folder
// must use the real current path each time instead of assuming a fixed depth.
test('moveFiles moves a note to its parent folder and into a child folder', async () => {
	const a = file('src/a.md');
	const t = file('dst/sub/t.md');
	const { panel, renamed } = panelFor([], [a], { files: [a, t] });
	let result = await panel.moveFiles('dst', [t]);
	assert.deepEqual(result.succeeded, ['dst/t.md']);
	assert.equal(t.path, 'dst/t.md');
	result = await panel.moveFiles('dst/sub/deep', [t]);
	assert.deepEqual(result.succeeded, ['dst/sub/deep/t.md']);
	assert.equal(t.path, 'dst/sub/deep/t.md');
	assert.deepEqual(renamed, [
		['dst/sub/t.md', 'dst/t.md'],
		['dst/t.md', 'dst/sub/deep/t.md'],
	]);
});

// Absolute, Windows-drive and dot-segment targets are outside the vault even
// when they point at a plausible folder name.
test('panel rejects absolute and dot-segment target folders', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	for (const target of ['C:/outside', 'archive/../outside', './archive', '..']) {
		Notice.messages = [];
		const { panel, el } = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t] });
		const input = el.querySelector('.related-operations-target-folder');
		input.value = target;
		input.fire('input');
		await panel.moveSelected();
		assert.match(Notice.messages.at(-1), /vault 内/, `${target} 应被拒绝`);
		assert.equal(t.path, 'dst/t.md');
	}
});

// A batch can fail halfway and be retried with only the remaining notes. The
// earlier successes must stay in the undo record instead of being overwritten
// by the retry, otherwise the user can no longer restore the first batch.
test('retrying after a partial batch keeps earlier successes undoable', async () => {
	const a = file('src/a.md');
	const good = file('dst/good.md');
	const bad = file('dst/bad.md');
	const { panel, renamed } = panelFor([], [a], { files: [a, good, bad] });
	const rename = panel.app.fileManager.renameFile;
	let failOnce = true;
	panel.app.fileManager.renameFile = async (item, destination) => {
		if (item.path === 'dst/bad.md' && failOnce) {
			failOnce = false;
			throw new Error('locked');
		}
		await rename(item, destination);
	};
	const first = await panel.moveFiles('archive', [good, bad]);
	assert.deepEqual(first.succeeded, ['archive/good.md']);
	assert.deepEqual(first.failed.map((item) => item.path), ['dst/bad.md']);
	const retry = await panel.moveFiles('archive', [bad]);
	assert.deepEqual(retry.succeeded, ['archive/bad.md']);
	assert.deepEqual(panel.lastMove, [
		{ from: 'dst/good.md', to: 'archive/good.md' },
		{ from: 'dst/bad.md', to: 'archive/bad.md' },
	]);
	await panel.undoLastMove();
	assert.equal(good.path, 'dst/good.md');
	assert.equal(bad.path, 'dst/bad.md');
	assert.deepEqual(panel.lastMove, []);
	assert.deepEqual(renamed, [
		['dst/good.md', 'archive/good.md'],
		['dst/bad.md', 'archive/bad.md'],
		['archive/bad.md', 'dst/bad.md'],
		['archive/good.md', 'dst/good.md'],
	]);
});

// Undo is idempotent: once everything is restored, pressing it again must not
// emit a misleading result notice or touch any file.
test('undoLastMove is a safe no-op after a successful undo', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { panel, renamed } = panelFor([], [a], { files: [a, t] });
	await panel.moveFiles('archive', [t]);
	await panel.undoLastMove();
	const renamedAfterFirstUndo = renamed.length;
	Notice.messages = [];
	await panel.undoLastMove();
	assert.deepEqual(Notice.messages, []);
	assert.equal(renamed.length, renamedAfterFirstUndo);
	assert.equal(t.path, 'dst/t.md');
});

// A restore skipped because the original path was occupied must remain
// retryable after the occupant is removed.
test('undoLastMove retries a skipped restore once the original path is free', async () => {
	const a = file('src/a.md');
	const t1 = file('dst/t1.md');
	const t2 = file('dst/t2.md');
	const { panel, renamed } = panelFor([], [a], { files: [a, t1, t2] });
	await panel.moveFiles('archive', [t1, t2]);
	const occupant = file('dst/t2.md');
	const files = panel.app.vault.getAllLoadedFiles();
	files.push(occupant);
	Notice.messages = [];
	await panel.undoLastMove();
	assert.match(Notice.messages.at(-1), /已跳过：1/);
	assert.equal(t1.path, 'dst/t1.md');
	assert.equal(t2.path, 'archive/t2.md');
	assert.deepEqual(panel.lastMove, [{ from: 'dst/t2.md', to: 'archive/t2.md' }]);
	files.splice(files.indexOf(occupant), 1);
	await panel.undoLastMove();
	assert.equal(t2.path, 'dst/t2.md');
	assert.deepEqual(panel.lastMove, []);
	assert.deepEqual(renamed.at(-1), ['archive/t2.md', 'dst/t2.md']);
});

// Group select-all is a toggle, and the explicit clear button must reset both
// the checkboxes and the cross-tab summary without a re-render.
test('select-all toggles off and clear selection resets counters', () => {
	const a = file('src/a.md');
	const t1 = file('dst/t1.md');
	const t2 = file('dst/t2.md');
	const { el } = panelFor([
		{ file: t1, relation: 'outgoing', sourceFile: a },
		{ file: t2, relation: 'outgoing', sourceFile: a },
	], [a], { files: [a, t1, t2], settings: { groupingMode: 'none', hideCompliant: false } });
	const summary = () => el.querySelector('.related-operations-selection-summary').textContent;
	const boxes = () => el.querySelectorAll('tr[data-related-path] input[type="checkbox"]');
	const selectAll = () => el.querySelector('.related-operations-select-all');
	selectAll().fire('click');
	assert.deepEqual(boxes().map((box) => box.checked), [true, true]);
	assert.equal(summary(), '已选 2 篇（跨标签页）');
	selectAll().fire('click');
	assert.deepEqual(boxes().map((box) => box.checked), [false, false]);
	assert.equal(summary(), '已选 0 篇（跨标签页）');
	boxes()[0].checked = true;
	boxes()[0].fire('change');
	assert.equal(summary(), '已选 1 篇（跨标签页）：t1');
	el.querySelectorAll('.related-operations-list-toolbar button').find((button) => button.textContent === '清空选择').fire('click');
	assert.deepEqual(boxes().map((box) => box.checked), [false, false]);
	assert.equal(summary(), '已选 0 篇（跨标签页）');
});

// Switching the source note recreates the panel inside the same view. Undo
// must stay available for moves made moments earlier in that view instead of
// being silently dropped with the old panel.
test('switching source notes keeps the view undo history', async () => {
	const a = file('src/a.md');
	const b = file('src/b.md');
	const t = file('dst/t.md');
	const { app } = makeApp([a, b, t], { 'src/a.md': { 'dst/t.md': 1 } });
	const view = new RelatedNotesView({ app }, { groupingMode: 'none', hideCompliant: false }, async () => {});
	await view.setState({ sourcePaths: ['src/a.md'], mergeTargetView: false }, { history: false });
	const firstPanel = view.panel;
	firstPanel.selections.set('dst/t.md', true);
	const input = view.contentEl.querySelector('.related-operations-target-folder');
	input.value = 'archive';
	input.fire('input');
	await moveSelectedConfirmed(firstPanel);
	assert.equal(t.path, 'archive/t.md');
	assert.deepEqual(view.panel.lastMove, [{ from: 'dst/t.md', to: 'archive/t.md' }]);

	await view.setState({ sourcePaths: ['src/b.md'], mergeTargetView: false }, { history: false });
	assert.equal(view.contentEl.querySelector('tr[data-related-path]'), null);
	assert.deepEqual(view.panel.lastMove, [{ from: 'dst/t.md', to: 'archive/t.md' }]);
	assert.equal(view.contentEl.querySelector('.related-operations-undo').disabled, false);
	await view.panel.undoLastMove();
	assert.equal(t.path, 'dst/t.md');
	assert.deepEqual(view.panel.lastMove, []);
	assert.equal(view.contentEl.querySelector('.related-operations-undo').disabled, true);
});

// The cleanup entry may recreate the panel when switching tabs. Moves made
// moments earlier must stay undoable for the same vault session.
test('recreating the panel for the same vault keeps undo history', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const first = panelFor([{ file: t, relation: 'outgoing', sourceFile: a }], [a], { files: [a, t] });
	first.panel.selections.set('dst/t.md', true);
	const input = first.el.querySelector('.related-operations-target-folder');
	input.value = 'archive';
	input.fire('input');
	await moveSelectedConfirmed(first.panel);
	assert.equal(t.path, 'archive/t.md');

	const second = panelFor([], [a], { app: first.app });
	assert.equal(second.el.querySelector('.related-operations-undo').disabled, false);
	await second.panel.undoLastMove();
	assert.equal(t.path, 'dst/t.md');
	assert.deepEqual(second.panel.lastMove, []);
});

// Closing and reopening the view must not lose the moves made in this vault
// session; only a plugin reload/restart should clear the in-memory record.
test('reopening the related view keeps undo history for the same vault', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { app } = makeApp([a, t], { 'src/a.md': { 'dst/t.md': 1 } });
	const settings = { groupingMode: 'none', hideCompliant: false };
	const first = new RelatedNotesView({ app }, settings, async () => {});
	await first.setState({ sourcePaths: ['src/a.md'], mergeTargetView: false }, { history: false });
	first.panel.selections.set('dst/t.md', true);
	const input = first.contentEl.querySelector('.related-operations-target-folder');
	input.value = 'archive';
	input.fire('input');
	await moveSelectedConfirmed(first.panel);
	await first.onClose();

	const second = new RelatedNotesView({ app }, settings, async () => {});
	await second.setState({ sourcePaths: ['src/a.md'], mergeTargetView: false }, { history: false });
	assert.equal(second.contentEl.querySelector('.related-operations-undo').disabled, false);
	await second.panel.undoLastMove();
	assert.equal(t.path, 'dst/t.md');
	assert.deepEqual(second.panel.lastMove, []);
});

// A selected note that disappeared before the rename finishes must produce an
// actionable message instead of leaking a raw filesystem error into the UI.
test('moveFiles explains a note deleted before the move instead of showing a raw error', async () => {
	const a = file('src/a.md');
	const t = file('dst/t.md');
	const { panel } = panelFor([], [a], { files: [a, t] });
	panel.app.fileManager.renameFile = async () => {
		throw new Error('ENOENT: no such file or directory');
	};
	const result = await panel.moveFiles('archive', [t]);
	assert.deepEqual(result.failed, [{
		path: 'dst/t.md',
		reason: '笔记已不存在或已被移动',
		kind: 'other',
		nextStep: '请刷新关联笔记后重试。',
	}]);
	assert.deepEqual(panel.lastMove, []);
});
