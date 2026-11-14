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
			let node = el;
			for (let i = parts.length - 1; i >= 0; i--) {
				if (!node || !node.matches(parts[i])) return false;
				if (i > 0) node = node.parent;
			}
			return true;
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
export class Modal { constructor(app) { this.app = app; } open() {} close() {} }
export class Notice { constructor(message) { Notice.messages.push(message); } static messages = []; }
export const normalizePath = (p) => String(p).replace(/^\\/+|\\/+$/g, '').replace(/\\/\\.\\//g, '/');
export const Platform = {};
`;
const bundle = await build({
	stdin: { contents: "export { RelatedNotesPanel } from './src/related-notes-modal.ts'; export { TFile, TFolder, Notice } from 'obsidian';", resolveDir: process.cwd() },
	bundle: true, write: false, format: 'esm', platform: 'node',
	plugins: [{ name: 'obsidian-stub', setup(b) {
		b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
		b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub }));
	} }],
});
const { RelatedNotesPanel, TFile, TFolder, Notice } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function makeApp(files) {
	const byPath = new Map(files.map((f) => [f.path, f]));
	const renamed = [];
	return {
		app: {
			metadataCache: { resolvedLinks: {}, getFileCache: () => ({}) },
			vault: {
				getAllLoadedFiles: () => files,
				getAbstractFileByPath: (p) => byPath.get(p) ?? null,
				createFolder: async (p) => { const f = new TFolder(p); files.push(f); byPath.set(p, f); },
			},
			fileManager: { renameFile: async (file, dest) => { renamed.push([file.path, dest]); file.path = dest; } },
			workspace: { openLinkText: async () => {} },
		},
		renamed,
	};
}

function panelFor(relatedNotes, sourceFiles, host = { close() {} }) {
	const { app, renamed } = makeApp([]);
	const el = document.createElement('div');
	const panel = new RelatedNotesPanel(app, el, sourceFiles[0], sourceFiles, relatedNotes, host);
	panel.render();
	return { panel, el, renamed };
}

const file = (path) => new TFile(path);

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
