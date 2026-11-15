import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Panel-flow test: selections feed confirmConvertWikiLinks, which revalidates,
// groups by source, and rewrites the note through vault.process.
const stub = `
export class Component {}
export class Notice { constructor(message) { Notice.messages.push(message); } static messages = []; }
export class TAbstractFile {}
export class TFile { constructor(path) { this.path = path; this.extension = 'md'; } }
export class TFolder {}
export class App {}
export class FileSystemAdapter {}
export class Modal {}
export class MarkdownView {}
export const Platform = {};
export const normalizePath = p => p;
export const setIcon = () => {};
`;
const modalStub = `
export class ConvertWikiLinksConfirmationModal {
	static requests = [];
	constructor(app, count) { this.count = count; }
	async waitForConfirmation() { ConvertWikiLinksConfirmationModal.requests.push(this.count); return true; }
}
export class ConvertNativeLinksConfirmationModal { async waitForConfirmation() { return true; } }
export class CreateNotesConfirmationModal { async waitForConfirmation() { return true; } }
export class RemoveBrokenLinksConfirmationModal { async waitForConfirmation() { return true; } }
export class ImagePreviewModal { open() {} }
`;
const bundle = await build({
	stdin: {
		contents: `
			export { OrphanCleanupPanel as Panel } from './src/orphan-cleanup.ts';
			export { confirmConvertWikiLinks } from './src/cleanup/cleanup-flows.ts';
			export { findWikiNoteLinks, wikiNoteLinkKey } from './src/wiki-note-links.ts';
		`,
		resolveDir: process.cwd(),
	},
	bundle: true, write: false, format: 'esm', platform: 'node',
	plugins: [{ name: 'stub', setup(b) {
		b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
		b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub }));
		b.onResolve({ filter: /cleanup-modals(\.ts)?$/ }, () => ({ path: 'cleanup-modals', namespace: 'modal-stub' }));
		b.onLoad({ filter: /.*/, namespace: 'modal-stub' }, () => ({ contents: modalStub }));
	} }],
});
const { Panel, confirmConvertWikiLinks, findWikiNoteLinks, wikiNoteLinkKey } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const noteContent = '前文 [[a|笔记]] 后文';
function makeApp({ resolve = true } = {}) {
	const cache = {
		links: [{ original: '[[a|笔记]]', link: 'a', position: { start: { offset: 3 }, end: { offset: 11 } } }],
	};
	const target = { path: '目标/a.md', extension: 'md' };
	const file = { path: 'note.md', extension: 'md' };
	const writes = [];
	const app = {
		metadataCache: {
			getFileCache: () => cache,
			getFirstLinkpathDest: () => (resolve ? target : null),
		},
		vault: {
			getMarkdownFiles: () => [file],
			getFileByPath: (path) => (path === 'note.md' ? file : null),
			process: async (f, fn) => { const next = fn(noteContent); if (next !== noteContent) writes.push(next); },
		},
	};
	return { app, writes, file };
}

function makePanel(app, options = {}) {
	const panel = new Panel(app, {}, { orphanImageExtensions: 'png', orphanIgnoredFolders: '' }, {}, options);
	panel.renderContents = () => {};
	return panel;
}

test('selected wiki links convert through the panel flow with counts and notice', async () => {
	const { app, writes } = makeApp();
	const savedCaches = [];
	const panel = makePanel(app, { saveCache: (cache) => savedCaches.push(cache) });
	panel.candidates.wikiLinks = findWikiNoteLinks(app);
	panel.hasScanned = true;
	assert.equal(panel.candidates.wikiLinks.length, 1);
	panel.wikiSelections.add(wikiNoteLinkKey(panel.candidates.wikiLinks[0]));
	panel.activeTab = 'wiki-links';

	await confirmConvertWikiLinks(panel);

	assert.deepEqual(writes, ['前文 [笔记](<目标/a.md>) 后文']);
	assert.deepEqual(panel.processed, { success: 1, skipped: 0, failed: [] });
	assert.equal(panel.wikiSelections.size, 0);
	assert.equal(savedCaches.length, 1);
});

test('unresolved targets after revalidation are skipped without writing', async () => {
	const { app, writes } = makeApp({ resolve: false });
	const panel = makePanel(app);
	panel.candidates.wikiLinks = findWikiNoteLinks({ ...app, metadataCache: { ...app.metadataCache, getFirstLinkpathDest: () => ({ path: '目标/a.md' }) } });
	panel.hasScanned = true;
	panel.wikiSelections.add(wikiNoteLinkKey(panel.candidates.wikiLinks[0]));

	await confirmConvertWikiLinks(panel);

	assert.deepEqual(writes, []);
	assert.deepEqual(panel.processed, { success: 0, skipped: 1, failed: [] });
});
