import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const stub = `
export class TAbstractFile { constructor(path) { this.path = path; } }
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class App {}
`;
const bundle = await build({
	stdin: {
		contents: "export { updateLinkStats, migrateLinkStatsProperties, findLinkStatsPropertyConflicts } from './src/link-stats.ts';",
		resolveDir: process.cwd(),
	},
	bundle: true, write: false, format: 'esm', platform: 'node',
	plugins: [{ name: 'obsidian-stub', setup(b) {
		b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
		b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub }));
	} }],
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { updateLinkStats, migrateLinkStatsProperties, findLinkStatsPropertyConflicts } = mod;

const settings = {
	enabled: true,
	autoUpdate: true,
	incomingProperty: 'in',
	outgoingProperty: 'out',
	bidirectionalProperty: 'both',
};

function setup(files, frontmatterByPath) {
	const writes = [];
	const app = {
		metadataCache: {
			resolvedLinks: {},
			getFileCache: (file) => ({ frontmatter: { ...(frontmatterByPath[file.path] ?? {}) } }),
		},
		vault: { getMarkdownFiles: () => files },
		fileManager: {
			processFrontMatter: async (file, cb) => {
				writes.push(file.path);
				const fm = frontmatterByPath[file.path] ?? (frontmatterByPath[file.path] = {});
				cb(fm);
			},
		},
	};
	return { app, writes };
}

const file = (path) => ({ path, extension: 'md' });

test('updateLinkStats skips notes whose property values already match', async () => {
	const a = file('a.md');
	const { app, writes } = setup([a], { 'a.md': { in: 0, out: 0, both: 0 } });
	const updated = await updateLinkStats(app, [a], settings);
	assert.equal(updated, 0);
	assert.deepEqual(writes, []);
});

test('updateLinkStats rewrites stale numeric values once', async () => {
	const a = file('a.md');
	const fm = { 'a.md': { in: 5, out: 0, both: 0 } };
	const { app, writes } = setup([a], fm);
	const updated = await updateLinkStats(app, [a], settings);
	assert.equal(updated, 1);
	assert.deepEqual(writes, ['a.md']);
	assert.equal(fm['a.md'].in, 0);
});

test('updateLinkStats rewrites array and empty-string values to numbers', async () => {
	const a = file('a.md');
	const fm = { 'a.md': { in: [1], out: '', both: {} } };
	const { app, writes } = setup([a], fm);
	const updated = await updateLinkStats(app, [a], settings);
	assert.equal(updated, 1);
	assert.deepEqual(fm['a.md'], { in: 0, out: 0, both: 0 });
	assert.deepEqual(writes, ['a.md']);
});

test('updateLinkStats treats stringified numbers as mismatches', async () => {
	const a = file('a.md');
	const fm = { 'a.md': { in: '0', out: '0', both: '0' } };
	const { app } = setup([a], fm);
	const updated = await updateLinkStats(app, [a], settings);
	assert.equal(updated, 1);
	assert.deepEqual(fm['a.md'], { in: 0, out: 0, both: 0 });
});

test('migrate moves values and removes obsolete property names', async () => {
	const a = file('a.md');
	const fm = { 'a.md': { oldIn: 3, oldOut: 4, oldBoth: 5, title: 'keep' } };
	const { app } = setup([a], fm);
	const migrated = await migrateLinkStatsProperties(
		app, [a],
		{ incomingProperty: 'oldIn', outgoingProperty: 'oldOut', bidirectionalProperty: 'oldBoth' },
		{ incomingProperty: 'newIn', outgoingProperty: 'newOut', bidirectionalProperty: 'newBoth' },
	);
	assert.equal(migrated, 1);
	assert.deepEqual(fm['a.md'], { title: 'keep', newIn: 3, newOut: 4, newBoth: 5 });
});

test('migrate is a no-op when names are unchanged', async () => {
	const a = file('a.md');
	const { app } = setup([a], { 'a.md': { in: 1 } });
	assert.equal(await migrateLinkStatsProperties(app, [a], settings, settings), 0);
});

test('conflicts report each overwritten name with its note path', () => {
	const a = file('a.md');
	const b = file('b.md');
	const { app } = setup([a, b], { 'a.md': { title: 'x' }, 'b.md': { newOut: 1 } });
	assert.deepEqual(
		findLinkStatsPropertyConflicts(
			app, [a, b],
			{ incomingProperty: 'in', outgoingProperty: 'out', bidirectionalProperty: 'both' },
			{ incomingProperty: 'newIn', outgoingProperty: 'newOut', bidirectionalProperty: 'newBoth' },
		),
		[{ path: 'b.md', property: 'newOut' }],
	);
});

test('updateLinkStats treats null and undefined values as stale', async () => {
	const a = file('a.md');
	const fm = { 'a.md': { in: null, out: undefined, both: 0 } };
	const { app } = setup([a], fm);
	assert.equal(await updateLinkStats(app, [a], settings), 1);
	assert.deepEqual(fm['a.md'], { in: 0, out: 0, both: 0 });
});

test('updateLinkStats counts only notes that were actually rewritten', async () => {
	const fresh = file('fresh.md');
	const stale = file('stale.md');
	const fm = { 'fresh.md': { in: 0, out: 0, both: 0 }, 'stale.md': { in: 9, out: 0, both: 0 } };
	const { app, writes } = setup([fresh, stale], fm);
	assert.equal(await updateLinkStats(app, [fresh, stale], settings), 1);
	assert.deepEqual(writes, ['stale.md']);
});

test('updateLinkStats tolerates notes without a metadata cache entry', async () => {
	const a = file('a.md');
	const app = {
		metadataCache: { resolvedLinks: {}, getFileCache: () => null },
		vault: { getMarkdownFiles: () => [a] },
		fileManager: { processFrontMatter: async (_file, cb) => { const fm = {}; cb(fm); assert.deepEqual(fm, { in: 0, out: 0, both: 0 }); } },
	};
	assert.equal(await updateLinkStats(app, [a], settings), 1);
});

test('migrate keeps a property name that stays the same role', async () => {
	const a = file('a.md');
	const fm = { 'a.md': { keptIn: 7, outOld: 2, bothOld: 3 } };
	const { app } = setup([a], fm);
	await migrateLinkStatsProperties(
		app, [a],
		{ incomingProperty: 'keptIn', outgoingProperty: 'outOld', bidirectionalProperty: 'bothOld' },
		{ incomingProperty: 'keptIn', outgoingProperty: 'outNew', bidirectionalProperty: 'bothNew' },
	);
	assert.deepEqual(fm['a.md'], { keptIn: 7, outNew: 2, bothNew: 3 });
});

test('migrate skips notes that do not carry any old property', async () => {
	const a = file('a.md');
	const b = file('b.md');
	const fm = { 'a.md': { oldIn: 1 }, 'b.md': { title: 'untouched' } };
	const { app, writes } = setup([a, b], fm);
	const migrated = await migrateLinkStatsProperties(
		app, [a, b],
		{ incomingProperty: 'oldIn', outgoingProperty: 'oldOut', bidirectionalProperty: 'oldBoth' },
		{ incomingProperty: 'newIn', outgoingProperty: 'newOut', bidirectionalProperty: 'newBoth' },
	);
	assert.equal(migrated, 1);
	assert.deepEqual(writes, ['a.md']);
	assert.deepEqual(fm['b.md'], { title: 'untouched' });
});

test('updateLinkStats writes a duplicated file path only once', async () => {
	const a = file('a.md');
	const fm = { 'a.md': { in: 9, out: 0, both: 0 } };
	const { app, writes } = setup([a], fm);
	assert.equal(await updateLinkStats(app, [a, a], settings), 1);
	assert.deepEqual(writes, ['a.md']);
	assert.equal(fm['a.md'].in, 0);
});

test('migrate writes a duplicated file path only once', async () => {
	const a = file('a.md');
	const fm = { 'a.md': { oldIn: 1 } };
	const { app, writes } = setup([a], fm);
	assert.equal(
		await migrateLinkStatsProperties(app, [a, a],
			{ incomingProperty: 'oldIn', outgoingProperty: 'oldOut', bidirectionalProperty: 'oldBoth' },
			{ incomingProperty: 'newIn', outgoingProperty: 'newOut', bidirectionalProperty: 'newBoth' },
		),
		1,
	);
	assert.deepEqual(writes, ['a.md']);
});
