import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.parent = null;
		this.dataset = {};
		this.className = '';
		this.attrs = {};
		this._text = '';
		this._listeners = [];
		this.disabled = false;
		this.title = '';
		this.type = '';
	}
	createDiv(options) { return this.createEl('div', options); }
	createSpan(options) { return this.createEl('span', options); }
	createEl(tag, options = {}) {
		const el = new El(tag);
		if (options.cls) el.className = options.cls;
		if (options.text !== undefined) el.setText(options.text);
		if (options.type !== undefined) el.type = options.type;
		this.children.push(el);
		el.parent = this;
		return el;
	}
	setText(text) { this._text = String(text); }
	get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
	addClass(...names) { for (const name of names) if (!this.hasClass(name)) this.className = this.className ? `${this.className} ${name}` : name; }
	removeClass(name) { this.className = this.className.split(/\s+/).filter((item) => item && item !== name).join(' '); }
	hasClass(name) { return this.className.split(/\s+/).includes(name); }
	setAttribute(key, value) { this.attrs[key] = String(value); }
	addEventListener(type, callback) { this._listeners.push({ type, callback }); }
	dispatch(type, event = {}) {
		for (const listener of [...this._listeners]) {
			if (listener.type === type) listener.callback({ preventDefault() {}, stopPropagation() {}, target: this, ...event });
		}
	}
	querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
	querySelectorAll(selector) {
		const result = [];
		const visit = (node) => {
			for (const child of node.children) {
				if (matches(child, selector)) result.push(child);
				visit(child);
			}
		};
		visit(this);
		return result;
	}
}

function matches(el, selector) {
	for (const part of selector.split(/\s+/)) {
		if (part.startsWith('.') && !el.hasClass(part.slice(1))) return false;
		if (part === 'button' && el.tagName !== 'BUTTON') return false;
	}
	return true;
}

const obsidianStub = `
export class TAbstractFile {}
export class TFile {}
export class TFolder {}
export class App {}
export class FileSystemAdapter {}
export class Notice { constructor(message) { globalThis.__notices.push(String(message)); } }
export const setIcon = () => {};
export const Platform = {};
`;

const modalStub = `
export class ConvertNativeLinksConfirmationModal { constructor() {} async waitForConfirmation() { return true; } }
export class ConvertWikiLinksConfirmationModal { constructor() {} async waitForConfirmation() { return true; } }
export class CreateNotesConfirmationModal { constructor() {} async waitForConfirmation() { return true; } }
export class RemoveBrokenLinksConfirmationModal { constructor() {} async waitForConfirmation() { return true; } }
export class ImagePreviewModal { constructor() {} open() {} }
`;

const bundle = await build({
	stdin: {
		contents: `
			export { requireSecondClick, resetArmedConfirmButtons } from './src/cleanup/cleanup-confirm-button.ts';
			export { renderActions } from './src/cleanup/cleanup-list-actions.ts';
			export { TFile } from 'obsidian';
		`,
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'node',
	plugins: [
		{
			name: 'obsidian-stub',
			setup(b) {
				b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'obsidian-stub' }));
				b.onLoad({ filter: /.*/, namespace: 'obsidian-stub' }, () => ({ contents: obsidianStub, loader: 'js' }));
			},
		},
		{
			name: 'cleanup-modals-stub',
			setup(b) {
				b.onResolve({ filter: /cleanup-modals(\.ts)?$/ }, () => ({ path: 'cleanup-modals', namespace: 'modal-stub' }));
				b.onLoad({ filter: /.*/, namespace: 'modal-stub' }, () => ({ contents: modalStub, loader: 'js' }));
			},
		},
	],
});

const source = bundle.outputFiles[0].text;
const { requireSecondClick, resetArmedConfirmButtons, renderActions, TFile } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

globalThis.__notices = [];
globalThis.window = {};

const timers = [];
let nextTimerId = 0;
globalThis.window.setTimeout = (fn, ms) => {
	const entry = { id: ++nextTimerId, fn, ms, cleared: false };
	timers.push(entry);
	return entry.id;
};
globalThis.window.clearTimeout = (id) => {
	const entry = timers.find((item) => item.id === id);
	if (entry) entry.cleared = true;
};
function runLastTimer() {
	const entry = [...timers].reverse().find((item) => !item.cleared);
	assert.ok(entry, 'expected a pending timer');
	entry.cleared = true;
	entry.fn();
}
function pendingTimers() { return timers.filter((item) => !item.cleared); }

beforeEach(() => {
	timers.length = 0;
	nextTimerId = 0;
	globalThis.__notices = [];
});

function button(text = '删除', cls = '') {
	const el = new El('button');
	el.className = cls;
	el.setText(text);
	return el;
}

test('第一次点击只进入待确认状态，不执行删除', () => {
	const target = button('删除选中文件', 'mod-cta');
	let confirmed = 0;
	requireSecondClick(target, () => { confirmed += 1; });
	target.dispatch('click');
	assert.equal(confirmed, 0);
	assert.equal(target.textContent, '确认删除');
	assert.ok(target.hasClass('is-armed-confirm'));
	assert.ok(target.hasClass('mod-warning'));
	assert.equal(target.attrs.title, '再次点击确认删除');
	assert.equal(target.attrs['aria-description'], '再次点击确认删除');
	assert.equal(pendingTimers().length, 1);
});

test('第二次点击执行删除并复位按钮', () => {
	const target = button('移入回收站', 'mod-cta');
	let confirmed = 0;
	requireSecondClick(target, () => { confirmed += 1; });
	target.dispatch('click');
	target.dispatch('click');
	assert.equal(confirmed, 1);
	assert.equal(target.textContent, '移入回收站');
	assert.ok(!target.hasClass('is-armed-confirm'));
	assert.ok(!target.hasClass('mod-warning'));
	assert.equal(pendingTimers().length, 0);
});

test('超时后复位，再次删除仍需两击', () => {
	const target = button('删除');
	let confirmed = 0;
	requireSecondClick(target, () => { confirmed += 1; }, { timeoutMs: 3000 });
	target.dispatch('click');
	runLastTimer();
	assert.equal(target.textContent, '删除');
	assert.ok(!target.hasClass('is-armed-confirm'));
	assert.equal(confirmed, 0);
	target.dispatch('click');
	assert.equal(confirmed, 0);
	target.dispatch('click');
	assert.equal(confirmed, 1);
});

test('焦点移出时复位待确认状态', () => {
	const target = button('删除');
	let confirmed = 0;
	requireSecondClick(target, () => { confirmed += 1; });
	target.dispatch('click');
	target.dispatch('blur');
	assert.equal(target.textContent, '删除');
	target.dispatch('click');
	assert.equal(confirmed, 0);
	target.dispatch('click');
	assert.equal(confirmed, 1);
});

test('选择变化可通过 resetArmedConfirmButtons 批量复位', () => {
	const root = new El('div');
	const armed = root.createEl('button', { text: '删除' });
	const plain = root.createEl('button', { text: '删除' });
	let confirmed = 0;
	requireSecondClick(armed, () => { confirmed += 1; });
	requireSecondClick(plain, () => { confirmed += 1; });
	armed.dispatch('click');
	resetArmedConfirmButtons(root);
	assert.equal(armed.textContent, '删除');
	assert.equal(pendingTimers().length, 0);
	armed.dispatch('click');
	armed.dispatch('click');
	plain.dispatch('click');
	assert.equal(confirmed, 1);
});

function makeVaultFile(path, bytes) {
	const file = new TFile();
	file.path = path;
	file.extension = path.split('.').pop();
	file.stat = { size: bytes.byteLength, mtime: 1 };
	return file;
}

function makeDuplicateGroup(files, hash) {
	return {
		hash,
		size: files[0].stat.size,
		files: files.map((file) => ({ path: file.path, extension: file.extension, size: file.stat.size, mtime: file.stat.mtime, referenced: false, referencingNotes: [] })),
	};
}

function makeHost(vaultFiles, groups, selection, contents) {
	const trashed = [];
	const host = {
		contentEl: new El('div'),
		app: {
			vault: {
				getFiles: () => vaultFiles,
				getMarkdownFiles: () => [],
				getAbstractFileByPath: (path) => vaultFiles.find((file) => file.path === path) ?? null,
				readBinary: async (file) => {
					const bytes = contents.get(file.path);
					if (!bytes) throw new Error('无法读取文件');
					return bytes;
				},
			},
			metadataCache: { resolvedLinks: {}, getFileCache: () => null, getFirstLinkpathDest: () => null },
			fileManager: { trashFile: async (file) => { trashed.push(file.path); } },
		},
		candidates: { images: [], attachments: [], emptyFiles: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [], duplicates: groups, duplicateWarnings: [] },
		duplicateSelections: new Set(selection),
		linkSelections: new Set(),
		nativeSelections: new Set(),
		noteLinkSelections: new Set(),
		selections: new Set(),
		settings: { orphanImageExtensions: 'png', orphanIgnoredFolders: '' },
		activeTab: 'duplicates',
		scanningTabs: new Set(),
		dirtyTabs: new Set(),
		renderCount: 0,
		renderContents() { this.renderCount += 1; },
		async scanTab() {},
		saveCacheToSettings() {},
	};
	return { host, trashed };
}

function toolbarButton(host) {
	renderActions(host);
	return host.contentEl.querySelectorAll('.mod-cta').filter((el) => el.tagName === 'BUTTON')[0];
}

function duplicateVault() {
	const sameBytes = new Uint8Array([1, 2, 3]);
	const whole = [makeVaultFile('whole/a.png', sameBytes), makeVaultFile('whole/b.png', sameBytes)];
	const partial = [makeVaultFile('partial/a.png', sameBytes), makeVaultFile('partial/b.png', sameBytes)];
	const vaultFiles = [...whole, ...partial];
	const contents = new Map(vaultFiles.map((file) => [file.path, sameBytes]));
	return { whole, partial, vaultFiles, contents };
}

async function waitFor(check, timeoutMs = 2000) {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error('等待删除流程完成超时');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test('工具栏整组全选两击后全组删除，内容变化项自动跳过', async () => {
	const { whole, partial, vaultFiles, contents } = duplicateVault();
	contents.set('whole/b.png', new Uint8Array([9, 9, 9]));
	const groups = [makeDuplicateGroup(whole, 'whole-hash'), makeDuplicateGroup(partial, 'partial-hash')];
	const { host, trashed } = makeHost(vaultFiles, groups, whole.map((file) => file.path), contents);
	const target = toolbarButton(host);

	target.dispatch('click');
	assert.equal(trashed.length, 0);
	assert.equal(target.textContent, '确认删除');

	target.dispatch('click');
	await waitFor(() => trashed.length >= 1);
	assert.deepEqual(trashed, ['whole/a.png']);
	assert.match(globalThis.__notices.at(-1), /whole\/b\.png（文件内容已变化，请重新扫描）/);
});

test('工具栏部分选中两击后删除选中项，保留项不动', async () => {
	const { whole, partial, vaultFiles, contents } = duplicateVault();
	const groups = [makeDuplicateGroup(whole, 'whole-hash'), makeDuplicateGroup(partial, 'partial-hash')];
	const { host, trashed } = makeHost(vaultFiles, groups, ['partial/b.png'], contents);
	const target = toolbarButton(host);

	target.dispatch('click');
	target.dispatch('click');
	await waitFor(() => trashed.length >= 1);
	assert.deepEqual(trashed, ['partial/b.png']);
});

test('按钮重绘后待确认状态不复用，单击新按钮不会删除', async () => {
	const { whole, partial, vaultFiles, contents } = duplicateVault();
	const groups = [makeDuplicateGroup(whole, 'whole-hash'), makeDuplicateGroup(partial, 'partial-hash')];
	const { host, trashed } = makeHost(vaultFiles, groups, whole.map((file) => file.path), contents);
	renderActions(host);
	const first = host.contentEl.querySelectorAll('.mod-cta').filter((el) => el.tagName === 'BUTTON')[0];
	first.dispatch('click');
	assert.equal(trashed.length, 0);

	// Simulate a repaint: the toolbar is rebuilt from scratch, so the old
	// armed button is gone and a brand-new unarmed button appears.
	host.contentEl.children.length = 0;
	const second = toolbarButton(host);
	assert.equal(second.textContent, '删除选中文件');
	second.dispatch('click');
	assert.equal(trashed.length, 0);
	assert.equal(second.textContent, '确认删除');
	second.dispatch('click');
	await waitFor(() => trashed.length >= 2);
	assert.deepEqual(trashed.sort(), ['whole/a.png', 'whole/b.png']);
});
