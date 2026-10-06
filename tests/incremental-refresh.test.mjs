import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { findChangedLinkPaths } from '../src/link-stats-core.ts';

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
	stdin: { contents: "export { default as Plugin } from './src/main.ts'; export { OrphanCleanupPanel as Panel } from './src/orphan-cleanup.ts'; export { TFile } from 'obsidian';", resolveDir: process.cwd() },
	bundle: true, write: false, format: 'esm', platform: 'node',
	plugins: [{ name: 'obsidian-stub', setup(b) {
		b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
		b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub }));
	} }],
});
const { Plugin, Panel, TFile } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function events() {
	const listeners = new Map();
	return {
		on(name, cb) { const list = listeners.get(name) ?? new Set(); list.add(cb); listeners.set(name, list); return { dispose: () => list.delete(cb) }; },
		emit(name, ...args) { for (const cb of listeners.get(name) ?? []) cb(...args); },
	};
}

test('changed links include both endpoints and removed targets, leaving unrelated paths out', () => {
	assert.deepEqual([...findChangedLinkPaths({ a: { b: 1 }, x: { y: 1 } }, { a: { c: 1 }, x: { y: 1 } })].sort(), ['a', 'b', 'c']);
	assert.equal(findChangedLinkPaths({ a: { b: 1 } }, { a: { b: 1 } }).size, 0);
});

test('automatic edits and periodic checks avoid reading unrelated frontmatter', async () => {
	const timers = new Map(); let id = 0; let tick;
	globalThis.window = { setTimeout: cb => { timers.set(++id, cb); return id; }, clearTimeout: id => timers.delete(id), setInterval: cb => { tick = cb; return 1; } };
	const metadata = events(), vault = events();
	const files = ['a.md', 'b.md', 'unrelated.md'].map(path => new TFile(path));
	const caches = Object.fromEntries(files.map(f => [f.path, { frontmatter: {} }]));
	const checked = [];
	const plugin = new Plugin();
	plugin.app = { vault: { ...vault, getMarkdownFiles: () => files }, metadataCache: { ...metadata, resolvedLinks: {}, getFileCache: f => { checked.push(f.path); return caches[f.path]; } }, fileManager: { processFrontMatter: async (f, cb) => cb(caches[f.path].frontmatter) } };
	plugin.settings = { enabled: true, autoUpdate: true, incomingProperty: 'in', outgoingProperty: 'out', bidirectionalProperty: 'both' };
	plugin.registerLinkStatsUpdater(); await plugin.linkStatsUpdate; checked.length = 0;
	plugin.app.metadataCache.resolvedLinks = { 'a.md': { 'b.md': 1 } };
	vault.emit('modify', files[0]); metadata.emit('changed', files[0]); metadata.emit('resolved');
	for (const cb of [...timers.values()]) cb(); timers.clear();
	await plugin.linkStatsUpdate;
	assert.deepEqual(checked.sort(), ['a.md', 'b.md']);
	assert.equal(caches['b.md'].frontmatter.in, 1);
	checked.length = 0; tick(); await plugin.linkStatsUpdate;
	assert.deepEqual(checked, []);
	metadata.emit('changed', files[0]);
	for (const cb of [...timers.values()]) cb(); timers.clear();
	await plugin.linkStatsUpdate;
	assert.deepEqual(checked, ['a.md']);
	plugin.app.metadataCache.resolvedLinks = {}; await plugin.updateChangedLinkStatsOrNotice();
	assert.equal(caches['b.md'].frontmatter.in, 0);
	plugin.unload(); delete globalThis.window;
});

test('panel updates edited source only and repeated current-tab refresh is effective', async () => {
	const metadata = events(), vault = events(), checked = [];
	const file = new TFile('a.md');
	const app = { metadataCache: { ...metadata, getFileCache: f => { checked.push(f.path); return { links: [], embeds: [] }; }, getFirstLinkpathDest: () => null }, vault: { ...vault, getMarkdownFiles: () => { throw Error('unexpected full vault scan'); } } };
	const panel = new Panel(app, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {});
	panel.hasScanned = true; panel.renderContents = () => {};
	const link = { sourcePath: 'a.md', original: '[[gone]]', linkPath: 'gone', position: { start: { offset: 0 }, end: { offset: 8 } } };
	panel.candidates.brokenNoteLinks = [link, { ...link, sourcePath: 'other.md' }];
	panel.noteLinkSelections.add('a.md\u00000:8'); panel.noteLinkSelections.add('other.md\u00000:8');
	panel.load(); metadata.emit('changed', file);
	assert.deepEqual(checked, ['a.md', 'a.md', 'a.md']);
	assert.deepEqual(panel.candidates.brokenNoteLinks.map(l => l.sourcePath), ['other.md']);
	assert.deepEqual([...panel.noteLinkSelections], ['other.md\u00000:8']);
	panel.activeTab = 'broken-note-links'; app.vault.getMarkdownFiles = () => [file];
	await panel.refreshCurrentTab(); await panel.refreshCurrentTab();
	assert.equal(checked.length, 5);
	panel.dirtyTabs.clear();
	vault.emit('rename', file, 'old.md');
	for (const tab of ['images', 'attachments', 'empty-files', 'folders', 'duplicates', 'broken-links', 'native-links', 'broken-note-links']) {
		assert.equal(panel.dirtyTabs.has(tab), true, `${tab} must refresh after a file is renamed`);
	}
	await panel.activateTab('broken-note-links');
	assert.equal(panel.dirtyTabs.has('broken-note-links'), false);
	assert.equal(checked.length, 6);
	panel.unload(); metadata.emit('changed', file); assert.equal(checked.length, 6);
});

test('failed dirty-tab refresh remains dirty for the next attempt', async () => {
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
	const panel = new Panel({ metadataCache: events(), vault: events() }, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, { cachedCandidates: cached });
	panel.renderContents = () => {};
	panel.restoreFromCache();
	for (const tab of ['images', 'attachments', 'broken-links', 'native-links', 'broken-note-links', 'empty-files', 'folders', 'duplicates']) assert.equal(panel.dirtyTabs.has(tab), true);
});
