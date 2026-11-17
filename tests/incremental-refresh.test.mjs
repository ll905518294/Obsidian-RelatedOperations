import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Exercise the actual plugin and panel with Obsidian events and file writes stubbed.
const stub = `
export class Component {
  callbacks = [];
  register(cb) { this.callbacks.push(cb); }
  registerEvent(ref) { this.register(() => ref.dispose()); }
  registerInterval() {}
  load() { this.onload?.(); }
  unload() { this.callbacks.forEach(cb => cb()); }
}
export class Plugin extends Component {}
export class Modal extends Component {}
export class ItemView extends Component {}
export class PluginSettingTab extends Component {}
export class TAbstractFile {}
export class TFile extends TAbstractFile { constructor(path) { super(); this.path = path; this.extension = 'md'; } }
export class TFolder extends TAbstractFile {}
export class App {}
export class FileSystemAdapter {}
export class MarkdownView {}
export class Notice { constructor(message) { Notice.messages.push(message); } static messages = []; }
export const Platform = {};
export const normalizePath = p => p;
export const setIcon = () => {};
`;
const bundle = await build({
	stdin: { contents: "export { OrphanCleanupPanel as Panel } from './src/orphan-cleanup.ts'; export { TFile, Notice } from 'obsidian';", resolveDir: process.cwd() },
	bundle: true, write: false, format: 'esm', platform: 'node',
	plugins: [{ name: 'obsidian-stub', setup(b) {
		b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
		b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub }));
	} }],
});
const { Panel, TFile, Notice } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function events() {
	const listeners = new Map();
	return {
		on(name, cb) { const list = listeners.get(name) ?? new Set(); list.add(cb); listeners.set(name, list); return { dispose: () => list.delete(cb) }; },
		emit(name, ...args) { for (const cb of listeners.get(name) ?? []) cb(...args); },
	};
}

test('panel updates edited source only and repeated current-tab refresh is effective', async () => {
	globalThis.window = { setTimeout };
	const metadata = events(), vault = events(), checked = [];
	const file = new TFile('a.md');
	const app = { metadataCache: { ...metadata, getFileCache: f => { checked.push(f.path); return { links: [], embeds: [] }; }, getFirstLinkpathDest: () => null }, vault: { ...vault, getMarkdownFiles: () => { throw Error('unexpected full vault scan'); } } };
	const panel = new Panel(app, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
	panel.hasScanned = true; panel.renderContents = () => {};
	const link = { sourcePath: 'a.md', original: '[[gone]]', linkPath: 'gone', position: { start: { offset: 0 }, end: { offset: 8 } } };
	panel.candidates.brokenNoteLinks = [link, { ...link, sourcePath: 'other.md' }];
	panel.noteLinkSelections.add('a.md\u00000:8'); panel.noteLinkSelections.add('other.md\u00000:8');
	panel.load(); metadata.emit('changed', file);
	assert.deepEqual(checked, ['a.md', 'a.md', 'a.md', 'a.md']);
	assert.deepEqual(panel.candidates.brokenNoteLinks.map(l => l.sourcePath), ['other.md']);
	assert.deepEqual([...panel.noteLinkSelections], ['other.md\u00000:8']);
	panel.activeTab = 'broken-note-links'; app.vault.getMarkdownFiles = () => [file];
	await panel.refreshCurrentTab(); await panel.refreshCurrentTab();
	assert.equal(checked.length, 6);
	panel.dirtyTabs.clear();
	vault.emit('rename', file, 'old.md');
	for (const tab of ['images', 'attachments', 'empty-files', 'folders', 'duplicates', 'broken-links', 'native-links', 'broken-note-links', 'wiki-links', 'image-convert']) {
		assert.equal(panel.dirtyTabs.has(tab), true, `${tab} must refresh after a file is renamed`);
	}
	await panel.activateTab('broken-note-links');
	assert.equal(panel.dirtyTabs.has('broken-note-links'), false);
	assert.equal(checked.length, 7);
	panel.unload(); metadata.emit('changed', file); assert.equal(checked.length, 7);
});

test('failed dirty-tab refresh remains dirty for the next attempt', async () => {
	globalThis.window = { setTimeout };
	const metadata = events(), vault = events();
	let fail = true;
	const file = new TFile('a.md');
	const app = { metadataCache: { ...metadata, resolvedLinks: {}, getFileCache: () => ({ links: [], embeds: [] }), getFirstLinkpathDest: () => null }, vault: { ...vault, getMarkdownFiles: () => [file], cachedRead: async () => '', getFiles: () => { if (fail) throw Error('temporary read failure'); return []; } } };
	const panel = new Panel(app, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
	panel.hasScanned = true; panel.activeTab = 'images'; panel.renderContents = () => {};
	panel.markTabDirty('images');
	await panel.activateTab('images');
	assert.equal(panel.dirtyTabs.has('images'), true);
	fail = false;
	await panel.activateTab('images');
	assert.equal(panel.dirtyTabs.has('images'), false);
});

test('a change arriving during a category scan survives scan completion', async () => {
	let finishReferences;
	const panel = new Panel({}, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
	panel.app = { vault: { getFiles: () => [] } };
	panel.buildReferencedSet = () => new Promise(resolve => { finishReferences = resolve; });
	panel.markTabDirty('images');
	const scanning = panel.scanTab('images');
	panel.markTabDirty('images');
	finishReferences(new Set());
	await scanning;
	assert.equal(panel.dirtyTabs.has('images'), true, 'a newer change must not be acknowledged by an older scan');
});

test('failure in one category cannot roll back a newer result from another category', async () => {
	let failReferences;
	const panel = new Panel({ vault: { getFiles: () => [] } }, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
	panel.buildReferencedSet = () => new Promise((resolve, reject) => { failReferences = reject; });
	panel.markTabDirty('images');
	const scanning = panel.scanTab('images');
	const newer = [{ sourcePath: 'new.md' }];
	panel.candidates.brokenNoteLinks = newer;
	failReferences(Error('temporary read failure'));
	await scanning;
	assert.equal(panel.candidates.brokenNoteLinks, newer);
	assert.equal(panel.dirtyTabs.has('images'), true);
});

test('binary and Canvas modifications invalidate dependent categories without a scan', () => {
	const vault = events(), metadata = events();
	const panel = new Panel({ vault, metadataCache: metadata }, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
	panel.hasScanned = true; panel.load();
	const resource = new TFile('photo.png'); resource.extension = 'png';
	vault.emit('modify', resource);
	assert.equal(panel.dirtyTabs.has('duplicates'), true);
	panel.dirtyTabs.clear();
	const canvas = new TFile('board.canvas'); canvas.extension = 'canvas';
	vault.emit('modify', canvas);
	assert.equal(panel.dirtyTabs.has('images'), true);
	assert.equal(panel.dirtyTabs.has('attachments'), true);
	panel.unload();
});

test('events during a full scan are retained as dirty state', () => {
	const vault = events(), metadata = events();
	const panel = new Panel({ vault, metadataCache: metadata }, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
	panel.hasScanned = false; panel.scanning = true; panel.load();
	const resource = new TFile('photo.png'); resource.extension = 'png';
	vault.emit('modify', resource);
	metadata.emit('resolved');
	assert.equal(panel.dirtyTabs.has('duplicates'), true);
	assert.equal(panel.dirtyTabs.has('images'), true);
	panel.unload();
});

test('restored cache is treated as stale until each category is refreshed', () => {
	const cached = { images: [], attachments: [], emptyFiles: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], duplicates: [], duplicateWarnings: [] };
	const panel = new Panel({ metadataCache: events(), vault: events() }, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {}, {
		cachedCandidates: cached,
		cachedSettings: { orphanImageExtensions: 'png', orphanIgnoredFolders: '' },
	});
	panel.renderContents = () => {};
	panel.restoreFromCache();
	for (const tab of ['images', 'attachments', 'broken-links', 'native-links', 'broken-note-links', 'wiki-links', 'empty-files', 'folders', 'duplicates', 'image-convert']) assert.equal(panel.dirtyTabs.has(tab), true);
});

test('full scan stays on overview and publishes category results before completion', async () => {
	globalThis.window = { setInterval: () => 1, clearInterval: () => {} };
	const file = new TFile('attachment.pdf'); file.name = 'attachment.pdf'; file.extension = 'pdf'; file.stat = { size: 20, mtime: 0 };
	const app = { vault: { getFiles: () => [file], getMarkdownFiles: () => [], getRoot: () => ({ path: '', children: [] }) }, metadataCache: { resolvedLinks: {} } };
	const panel = new Panel(app, { querySelector: () => null, querySelectorAll: () => [] }, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
	const snapshots = [];
	panel.activeTab = 'attachments';
	panel.convertSelections.add('photo.png');
	panel.renderContents = () => snapshots.push({ scanning: panel.scanning, activeTab: panel.activeTab, completed: [...panel.scannedTabs], count: panel.candidates.attachments.length });
	await panel.scan();
	assert.equal(snapshots[0].activeTab, 'overview');
	assert.ok(snapshots.some(s => s.scanning && s.completed.includes('attachments') && !s.completed.includes('duplicates') && s.count === 1));
	assert.equal(panel.scannedTabs.size, 9);
	assert.equal(panel.scanning, false);
	assert.equal(panel.convertSelections.size, 0, '全量扫描必须清空转换选择');
	delete globalThis.window;
});

test('dashboard distinguishes waiting, scanning, stale and healthy results', () => {
	const panel = new Panel({}, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
	assert.equal(panel.categoryStatus(0, false, false, false), '尚未扫描');
	assert.equal(panel.categoryStatus(0, true, true, false), '正在扫描…');
	assert.equal(panel.categoryStatus(0, true, false, true), '结果待复核，请重新扫描');
	assert.equal(panel.categoryStatus(0, true, false, false), '未发现问题');
	assert.equal(panel.categoryStatus(4, true, false, false), '发现 4 项');
});

test('切换标签、重新估算与全量扫描都会清空转换选择', async () => {
	globalThis.window = { setTimeout };
	const panel = new Panel({ metadataCache: events(), vault: events() }, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
	panel.renderContents = () => {};
	panel.updateTabCounts = () => {};
	panel.scanTab = async () => {};
	panel.activeTab = 'overview';
	panel.convertSelections.add('a.png');
	await panel.activateTab('images');
	assert.equal(panel.convertSelections.size, 0, '切换标签必须清空转换选择');

	panel.convertSelections.add('b.png');
	panel.candidates.convertibleImages = [];
	await panel.estimateConversions();
	assert.equal(panel.convertSelections.size, 0, '重新估算开始时必须清空转换选择');
	delete globalThis.window;
});

test('convertSelected 不接受带 blockedReason 的条目', async () => {
	const panel = new Panel({ metadataCache: events(), vault: events() }, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
	panel.renderContents = () => {};
	panel.candidates.convertibleImages = [{ path: 'blocked.png', stat: { size: 1 } }];
	panel.conversion.items = [{ path: 'blocked.png', blockedReason: 'has-size' }];
	panel.convertSelections.add('blocked.png');
	Notice.messages.length = 0;
	await panel.convertSelected();
	assert.match(Notice.messages.at(-1), /不可转换/);
});

test('home tab totals all categories and issue tabs lead without changing their relative order', () => {
	const panel = new Panel({}, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
	panel.candidates.attachments = [{ path: 'a.pdf' }, { path: 'b.pdf' }];
	panel.candidates.nativeLinks = [{}, {}, {}];
	panel.candidates.duplicates = [{}, {}, {}, {}];
	let entries = panel.tabEntries();
	assert.deepEqual(entries[0], ['overview', '体检首页', 9]);
	assert.deepEqual(entries.slice(1, 4).map(([tab]) => tab), ['attachments', 'native-links', 'duplicates']);
	assert.equal(entries.length, 11);
	assert.deepEqual(entries.at(-1), ['image-convert', '图片转换', 0]);
	panel.candidates.attachments = [];
	entries = panel.tabEntries();
	assert.equal(entries[0][2], 7);
	assert.deepEqual(entries.slice(1, 3).map(([tab]) => tab), ['native-links', 'duplicates']);
	panel.scanning = true;
	assert.deepEqual(panel.tabEntries().slice(1, 4).map(([tab]) => tab), ['images', 'attachments', 'broken-links']);
	panel.scanning = false;
	panel.candidates.nativeLinks = []; panel.candidates.duplicates = [];
	assert.equal(panel.tabEntries()[0][2], 0);
	assert.equal(panel.tabEntries()[1][0], 'images');
	panel.candidates.convertibleImages = [{ path: 'photo.png' }];
	assert.equal(panel.tabEntries()[0][2], 0, '转换候选不改变首页问题总数');
	assert.deepEqual(panel.tabEntries().at(-1), ['image-convert', '图片转换', 1]);
});

test('stale tab paints immediately, shares its scan and does not redraw a newer tab', async () => {
	globalThis.window = { setTimeout };
	const panel = new Panel({}, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
	const renders = [];
	panel.renderContents = () => renders.push(panel.activeTab);
	panel.updateTabCounts = () => {};
	panel.markTabDirty('duplicates');
	let scans = 0, complete;
	panel.scanTab = () => { scans++; return new Promise(resolve => { complete = resolve; }); };
	const first = panel.activateTab('duplicates');
	assert.deepEqual(renders, ['duplicates'], 'selected view is rendered before scanning starts');
	assert.equal(panel.scanningTabs.has('duplicates'), true);
	assert.equal(scans, 0);
	const second = panel.activateTab('duplicates');
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(scans, 1, 'rapid clicks must share the same scan');
	await panel.activateTab('overview');
	const before = renders.length;
	complete(); await Promise.all([first, second]);
	assert.equal(panel.activeTab, 'overview');
	assert.deepEqual(renders.slice(before), ['overview'], 'completion refreshes overview without restoring the old tab');
	assert.equal(panel.scanningTabs.size, 0);
});

test('late refresh does not rebuild another category and disposed panel cannot start queued scan', async () => {
	globalThis.window = { setTimeout };
	const panel = new Panel({}, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
	const renders = []; let updates = 0, complete;
	panel.renderContents = () => renders.push(panel.activeTab);
	panel.updateTabCounts = () => { updates++; };
	panel.scannedTabs.add('attachments'); panel.markTabDirty('duplicates');
	panel.scanTab = () => new Promise(resolve => { complete = resolve; });
	const work = panel.activateTab('duplicates');
	await new Promise(resolve => setTimeout(resolve, 10));
	await panel.activateTab('attachments');
	const before = renders.length; complete(); await work;
	assert.equal(renders.length, before);
	assert.equal(updates, 1);
	let scans = 0; panel.scanTab = async () => { scans++; };
	const queued = panel.activateTab('duplicates'); panel.scanGeneration++;
	await queued; assert.equal(scans, 0);
});
