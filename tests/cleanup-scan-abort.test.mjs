import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const stub = `
export class TAbstractFile {}
export class TFile extends TAbstractFile { constructor(path) { super(); this.path = path; } }
export class TFolder extends TAbstractFile {}
export class App {}
export class FileSystemAdapter {}
export class Notice { constructor() {} }
export class Component { register() {} registerEvent() {} registerInterval() {} }
export class Modal extends Component {}
export class ItemView extends Component {}
export class PluginSettingTab extends Component {}
export class MarkdownView {}
export const setIcon = () => {};
export const normalizePath = p => p;
export const Platform = {};
`;

const bundle = await build({
	stdin: {
		contents: "export { findCleanupCandidates } from './src/cleanup/cleanup-scan.ts';",
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'node',
	plugins: [{
		name: 'obsidian-stub',
		setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
			b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub }));
		},
	}],
});

const { findCleanupCandidates } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function makeFile(path, content = '') {
	return {
		path,
		name: path.split('/').at(-1),
		extension: path.split('.').at(-1).toLowerCase(),
		stat: { size: content.length || 20, mtime: 0 },
		__content: content,
	};
}

function makeApp(files, extra = {}) {
	return {
		vault: {
			getFiles: () => files,
			getMarkdownFiles: () => files.filter((file) => file.extension === 'md'),
			getRoot: () => ({ path: '', children: [] }),
			cachedRead: async (file) => file.__content,
			read: async (file) => file.__content,
			...extra.vault,
		},
		metadataCache: { resolvedLinks: {}, getFileCache: () => null, getFirstLinkpathDest: () => null, ...extra.metadataCache },
	};
}

test('aborting between stages rejects with a recognizable error and keeps completed categories', async () => {
	const attachment = makeFile('orphan.pdf');
	const app = makeApp([attachment]);
	const controller = new AbortController();
	const completed = [];
	await assert.rejects(
		findCleanupCandidates(app, 'png', '', undefined, true, (tabs, results) => {
			completed.push({ tabs, results });
			if (tabs.includes('attachments')) controller.abort();
		}, controller.signal),
		(error) => error?.name === 'CleanupScanAbortedError',
	);
	assert.equal(completed.length, 1, '只有已经完成的分类会被发布');
	assert.deepEqual(completed[0].tabs, ['images', 'attachments']);
	assert.equal(completed[0].results.attachments.length, 1);
});

test('aborting during the text-reference pass stops before publishing category results', async () => {
	const image = makeFile('assets/photo.png');
	const note = makeFile('note.md', 'see photo.png');
	const app = makeApp([image, note]);
	const controller = new AbortController();
	const completed = [];
	const promise = findCleanupCandidates(app, 'png', '', (progress) => {
		if (progress.stage === 2 && progress.processed >= 1) controller.abort();
	}, true, (tabs, results) => {
		completed.push({ tabs, results });
	}, controller.signal);
	await assert.rejects(promise, (error) => error?.name === 'CleanupScanAbortedError');
	assert.equal(completed.length, 0);
});

test('an already aborted signal rejects before scanning starts', async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		findCleanupCandidates(makeApp([]), 'png', '', undefined, true, undefined, controller.signal),
		(error) => error?.name === 'CleanupScanAbortedError',
	);
});

test('aborting during duplicate hashing stops the scan', async () => {
	const first = makeFile('dup/a.bin', 'aa');
	const second = makeFile('dup/b.bin', 'bb');
	const app = makeApp([first, second], {
		vault: { readBinary: async (file) => new TextEncoder().encode(file.__content).buffer },
	});
	const controller = new AbortController();
	await assert.rejects(
		findCleanupCandidates(app, 'png', '', (progress) => {
			if (progress.stage === 5 && progress.processed >= 1) controller.abort();
		}, true, undefined, controller.signal),
		(error) => error?.name === 'CleanupScanAbortedError',
	);
});

test('a signal that is never aborted returns the full candidate set', async () => {
	const attachment = makeFile('orphan.pdf');
	const controller = new AbortController();
	const completed = [];
	const result = await findCleanupCandidates(makeApp([attachment]), 'png', '', undefined, true, (tabs, results) => {
		completed.push({ tabs, results });
	}, controller.signal);
	assert.equal(result.attachments.length, 1);
	assert.equal(completed.length, 5);
});
