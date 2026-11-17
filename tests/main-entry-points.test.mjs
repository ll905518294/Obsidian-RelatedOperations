import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// main.ts pulls in the whole plugin surface, so the obsidian stub has to cover
// every symbol the imported modules touch at load time. Only the plugin
// lifecycle hooks used by onload() need real behaviour.
const stub = `
function makeEl(tag) {
	const el = {
		tagName: String(tag).toUpperCase(),
		children: [],
		attrs: {},
		dataset: {},
		_text: '',
		classList: new Set(),
		style: { setProperty() {} },
		setText(value) { this._text = String(value); },
		createEl(childTag, options = {}) {
			const child = makeEl(childTag);
			if (options.text !== undefined) child.setText(options.text);
			if (options.cls) for (const name of String(options.cls).split(/\\s+/)) if (name) child.classList.add(name);
			child.parent = this;
			this.children.push(child);
			return child;
		},
		createDiv(options = {}) { return this.createEl('div', options); },
		createSpan(options = {}) { return this.createEl('span', options); },
		empty() { this.children = []; },
		remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); },
		addClass() {},
		removeClass() {},
		toggleClass() {},
		setAttribute(key, value) { this.attrs[key] = String(value); },
		getAttribute(key) { return this.attrs[key] ?? null; },
		addEventListener() {},
		removeEventListener() {},
		querySelector() { return null; },
		querySelectorAll() { return []; },
		get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); },
	};
	return el;
}
globalThis.window = { setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {} };
globalThis.document = { createElement: (tag) => makeEl(tag) };
export class TAbstractFile { constructor(path = '') { this.path = path; } }
export class TFile extends TAbstractFile {
	constructor(path = '') {
		super(path);
		const name = path.slice(path.lastIndexOf('/') + 1);
		this.name = name;
		this.extension = 'md';
		this.basename = name.replace(/\\.[^.]+$/, '');
		this.stat = { size: 0, mtime: 0 };
	}
}
export class TFolder extends TAbstractFile { constructor(path = '') { super(path); this.children = []; } }
export class App {}
export class Component {
	onload() {}
	onunload() {}
	registerEvent() {}
	register() {}
	addChild() {}
	load() {}
	unload() {}
}
export class Plugin extends Component {
	constructor(app, manifest) {
		super();
		this.app = app;
		this.manifest = manifest;
		this.__commands = [];
		this.__ribbon = [];
		this.__views = new Map();
	}
	async loadData() { return globalThis.__loadDataResult; }
	async saveData(data) { globalThis.__savedData = data; }
	registerView(type, factory) { this.__views.set(type, factory); }
	addSettingTab() {}
	addCommand(command) { this.__commands.push(command); return command; }
	addRibbonIcon(icon, title, callback) {
		const item = { icon, title, callback };
		this.__ribbon.push(item);
		return item;
	}
}
export class Modal {
	constructor(app) {
		this.app = app;
		this.modalEl = makeEl('div');
		this.titleEl = makeEl('div');
		this.contentEl = makeEl('div');
	}
	open() {}
	close() {}
}
export class ItemView extends Component {
	constructor(leaf) {
		super();
		this.leaf = leaf;
		this.app = leaf?.app;
		this.contentEl = makeEl('div');
	}
	async setState() {}
}
export class MarkdownView {}
export class Notice { constructor(message) { Notice.messages.push(message); } }
Notice.messages = [];
export const Platform = { isMobile: false, isDesktopApp: true };
export const normalizePath = (path) => String(path).replace(/^\\/+|\\/+$/g, '');
export const setIcon = () => {};
export class FileSystemAdapter {}
export class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
export class SettingDefinitionItem {}
`;

const bundle = await build({
	stdin: {
		contents: `
			export { default as RelatedOperationsPlugin } from './src/main.ts';
			export { TFile, TFolder, Notice, Platform } from 'obsidian';
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

const { RelatedOperationsPlugin, TFile, TFolder } = await import(
	`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

const ORPHAN_CLEANUP_VIEW_TYPE = 'related-operations-orphan-cleanup-view';
const RELATED_NOTES_VIEW_TYPE = 'related-operations-view';

function makeApp({ activeFile = null, files = [] } = {}) {
	const openedViews = [];
	const leaves = [];
	return {
		app: {
			workspace: {
				onLayoutReady() {},
				on() { return {}; },
				getActiveFile() { return activeFile; },
				getLeavesOfType(type) { return leaves.filter((leaf) => leaf.type === type); },
				getLeaf() {
					const leaf = {
						type: undefined,
						async setViewState(state) {
							leaf.type = state.type;
							openedViews.push(state.type);
						},
					};
					leaves.push(leaf);
					return leaf;
				},
				revealLeaf() {},
				requestSaveLayout() {},
				getActiveViewOfType() { return null; },
			},
			vault: {
				getMarkdownFiles() { return files; },
				getAbstractFileByPath(path) { return files.find((file) => file.path === path) ?? null; },
				on() { return {}; },
			},
			metadataCache: {
				on() { return {}; },
				getFileCache() { return {}; },
				resolvedLinks: {},
			},
			fileManager: {},
		},
		openedViews,
	};
}

async function loadPlugin(context) {
	const plugin = new RelatedOperationsPlugin(context.app, { name: 'Vault Doctor', version: '1.9.5' });
	await plugin.onload();
	return plugin;
}

test('只保留体检与清理一个 ribbon 图标', async () => {
	const context = makeApp();
	const plugin = await loadPlugin(context);

	assert.deepEqual(
		plugin.__ribbon.map((item) => item.title),
		['打开 vault 体检与清理'],
		'不得再注册「整理关联笔记」的独立侧栏图标',
	);
});

test('命令 move-related-notes 保留 ID 并改为打开体检与清理视图', async () => {
	const context = makeApp();
	const plugin = await loadPlugin(context);

	const command = plugin.__commands.find((item) => item.id === 'move-related-notes');
	assert.ok(command, '必须保留公开命令 ID move-related-notes');

	if (command.callback) command.callback();
	else command.checkCallback(false);
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.ok(
		context.openedViews.includes(ORPHAN_CLEANUP_VIEW_TYPE),
		'命令应打开体检与清理视图作为唯一入口',
	);
	assert.equal(
		context.openedViews.includes(RELATED_NOTES_VIEW_TYPE),
		false,
		'命令不应再单独新建关联笔记视图',
	);
});

test('体检页签内点击入口卡时沿用打开前的最近 Markdown 笔记', async () => {
	const note = new TFile('notes/a.md');
	const context = makeApp({ activeFile: note, files: [note] });
	const plugin = await loadPlugin(context);

	await plugin.openOrphanCleanupWindow();
	assert.ok(context.openedViews.includes(ORPHAN_CLEANUP_VIEW_TYPE));

	// 体检页签成为活动视图后，Obsidian 的 getActiveFile() 返回 null。
	context.app.workspace.getActiveFile = () => null;
	plugin.openRelatedNotesFromCurrent();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.ok(
		context.openedViews.includes(RELATED_NOTES_VIEW_TYPE),
		'应使用最近打开的 Markdown 笔记作为关联笔记源',
	);
});
