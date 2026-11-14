import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// related-notes.ts imports App/TFile from 'obsidian' (type-only at build, but
// the import is not `import type`), so we stub the module like
// incremental-refresh.test.mjs does. This exercises the real computation.
const stub = `
export class TAbstractFile { constructor(path) { this.path = path; } }
export class TFile extends TAbstractFile {
	constructor(path, extension = 'md') {
		super(path);
		this.extension = extension ?? 'md';
		this.basename = path.slice(path.lastIndexOf('/') + 1).replace(/\\.\\w+$/, '');
		this.name = this.basename + '.' + this.extension;
	}
}
export class TFolder extends TAbstractFile {}
export class App {}
`;
const bundle = await build({
	stdin: {
		contents: "export { getRelatedNotes, getRelatedNotesForFiles, relationLabel, defaultTargetFolder } from './src/related-notes.ts'; export { TFile } from 'obsidian';",
		resolveDir: process.cwd(),
	},
	bundle: true, write: false, format: 'esm', platform: 'node',
	plugins: [{ name: 'obsidian-stub', setup(b) {
		b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
		b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub }));
	} }],
});
const { getRelatedNotesForFiles, relationLabel, defaultTargetFolder, TFile } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const md = 'md';

function makeApp(resolvedLinks, files) {
	const byPath = new Map(files.map((f) => [f.path, f]));
	return {
		metadataCache: { resolvedLinks },
		vault: { getAbstractFileByPath: (path) => byPath.get(path) ?? null },
	};
}

function note(path, ext = md) { return new TFile(path, ext); }

// Regression: a note that is simultaneously an outgoing and incoming neighbour
// of the same source must be a single "both" entry, never doubled and never
// misreported as outgoing or incoming.
test('deduplicates a mutual link into a single bidirectional entry', () => {
	const a = note('a/alpha.md');
	const b = note('b/beta.md');
	const app = makeApp({
		'a/alpha.md': { 'b/beta.md': 1 },
		'b/beta.md': { 'a/alpha.md': 1 },
	}, [a, b]);
	const result = getRelatedNotesForFiles(app, [a]);
	assert.equal(result.length, 1);
	assert.equal(result[0].file.path, 'b/beta.md');
	assert.equal(result[0].relation, 'both');
	assert.equal(result[0].sourceFile.path, 'a/alpha.md');
});

// A note reached from a single source through two different link forms must be
// returned exactly once for that source (resolvedLinks dedupes by target path).
test('returns one entry per source even when resolved links repeat the target', () => {
	const a = note('a/alpha.md');
	const b = note('b/beta.md');
	const app = makeApp({
		'a/alpha.md': { 'b/beta.md': 2 },
	}, [a, b]);
	const result = getRelatedNotesForFiles(app, [a]);
	assert.equal(result.length, 1);
	assert.equal(result[0].relation, 'outgoing');
});

// Self-links must be excluded even if the source appears in resolvedLinks.
test('excludes self-links', () => {
	const a = note('a/alpha.md');
	const b = note('b/beta.md');
	const app = makeApp({
		'a/alpha.md': { 'a/alpha.md': 1, 'b/beta.md': 1 },
	}, [a, b]);
	const result = getRelatedNotesForFiles(app, [a]);
	assert.deepEqual(
		result.map((r) => r.file.path),
		['b/beta.md'],
	);
});

// Non-Markdown targets (images, attachments, Canvas) resolved by the cache must
// not be treated as notes.
test('ignores non-Markdown resolved targets', () => {
	const a = note('a/alpha.md');
	const img = note('att/photo.png', 'png');
	const app = makeApp({
		'a/alpha.md': { 'att/photo.png': 1 },
	}, [a, img]);
	const result = getRelatedNotesForFiles(app, [a]);
	assert.deepEqual(result, []);
});

// Across multiple source notes the same related note must be reported once per
// source (for the source column) so the UI/move list can dedupe by file path.
test('reports the same target once per source', () => {
	const a1 = note('a/one.md');
	const a2 = note('a/two.md');
	const target = note('c/target.md');
	const app = makeApp({
		'a/one.md': { 'c/target.md': 1 },
		'a/two.md': { 'c/target.md': 1 },
	}, [a1, a2, target]);
	const result = getRelatedNotesForFiles(app, [a1, a2]);
	assert.equal(result.length, 2);
	const sources = result.map((r) => r.sourceFile.path).sort();
	assert.deepEqual(sources, ['a/one.md', 'a/two.md']);
	assert.ok(result.every((r) => r.file.path === 'c/target.md'));
});

// Block/heading and alias references resolve through Obsidian's cache to the
// note path; the computation must not choke on subpaths or hash suffixes.
test('accepts resolved paths with heading and block subpaths', () => {
	const a = note('a/alpha.md');
	const b = note('b/beta.md');
	const app = makeApp({
		'a/alpha.md': { 'b/beta.md': 1 },
	}, [a, b]);
	const result = getRelatedNotesForFiles(app, [a]);
	assert.equal(result.length, 1);
	assert.equal(result[0].file.path, 'b/beta.md');
	assert.equal(relationLabel(result[0].relation), '出链');
});

// With multiple sources, the same target is reported once per source
// (as README describes for the source column), each with its own relation.
test('reports per-source relations when a target is linked from two sources', () => {
	const s1 = note('s/one.md');
	const s2 = note('s/two.md');
	const target = note('t/target.md');
	const app = makeApp({
		's/one.md': { 't/target.md': 1 },
		't/target.md': { 's/two.md': 1 },
	}, [s1, s2, target]);
	const result = getRelatedNotesForFiles(app, [s1, s2]);
	const targetRows = result.filter((r) => r.file.path === 't/target.md');
	assert.deepEqual(
		targetRows.map((r) => [r.sourceFile.path, r.relation]).sort(),
		[['s/one.md', 'outgoing'], ['s/two.md', 'incoming']],
	);
});

// Links between two selected sources are not "related notes" of the batch.
test('excludes links between selected source notes', () => {
	const s1 = note('s/one.md');
	const s2 = note('s/two.md');
	const app = makeApp({
		's/one.md': { 's/two.md': 1 },
		's/two.md': { 's/one.md': 1 },
	}, [s1, s2]);
	assert.deepEqual(getRelatedNotesForFiles(app, [s1, s2]), []);
});

test('labels each relation with the documented wording', () => {
	assert.equal(relationLabel('outgoing'), '出链');
	assert.equal(relationLabel('incoming'), '入链');
	assert.equal(relationLabel('both'), '出链 + 入链');
});

test('defaultTargetFolder joins the parent folder and note basename', () => {
	assert.equal(defaultTargetFolder(note('a/b/note.md')), 'a/b/note');
	assert.equal(defaultTargetFolder(note('root.md')), 'root');
});

// The vault path lookup is the sole source of truth for a target. If the cache
// emits a case variant of the same path, it either resolves to the same TFile
// (and must not duplicate) or to nothing (and must be dropped).
test('resolves case-variant target keys through the vault lookup without duplicating', () => {
	const a = note('a/alpha.md');
	const b = note('b/Beta.md');
	const byPath = new Map([[a.path, a], [b.path, b]]);
	const app = {
		metadataCache: { resolvedLinks: { 'a/alpha.md': { 'b/Beta.md': 1, 'b/beta.md': 1 } } },
		vault: { getAbstractFileByPath: (path) => byPath.get(path) ?? byPath.get([...byPath.keys()].find((key) => key.toLowerCase() === path.toLowerCase())) ?? null },
	};
	const result = getRelatedNotesForFiles(app, [a]);
	assert.equal(result.length, 1);
	assert.equal(result[0].file.path, 'b/Beta.md');
});

test('drops target keys that the vault cannot resolve', () => {
	const a = note('a/alpha.md');
	const app = {
		metadataCache: { resolvedLinks: { 'a/alpha.md': { 'b/%E4%B8%AD%E6%96%87.md': 1 } } },
		vault: { getAbstractFileByPath: () => null },
	};
	assert.deepEqual(getRelatedNotesForFiles(app, [a]), []);
});

// Hub notes (MOCs) make many edges point at one target. Each edge must be
// resolved a bounded number of times, not rescanned per candidate.
test('resolves each incoming edge a bounded number of times', () => {
	const target = note('hub/target.md');
	const sources = Array.from({ length: 50 }, (_, i) => note(`src/note-${i}.md`));
	const resolved = Object.fromEntries(sources.map((source) => [source.path, { 'hub/target.md': 1 }]));
	resolved['hub/target.md'] = {};
	let lookups = 0;
	const byPath = new Map([target, ...sources].map((file) => [file.path, file]));
	const app = {
		metadataCache: { resolvedLinks: resolved },
		vault: { getAbstractFileByPath: (path) => { lookups++; return byPath.get(path) ?? null; } },
	};
	assert.equal(getRelatedNotesForFiles(app, [target]).length, 50);
	assert.ok(lookups <= 50 * 4, `resolved ${lookups} paths for 50 edges`);
});

// Stale cache keys may point at folders instead of files; they must be ignored.
test('ignores resolved keys that are not files', () => {
	const source = note('src/note.md');
	const folder = { path: 'folder', children: [] };
	const app = {
		metadataCache: { resolvedLinks: { 'src/note.md': { folder: 1, 'ghost.md': 1 } } },
		vault: { getAbstractFileByPath: (path) => (path === 'folder' ? folder : null) },
	};
	assert.deepEqual(getRelatedNotesForFiles(app, [source]), []);
});

// The incoming pass must build the reverse map in one sweep over resolvedLinks
// and reuse the already-resolved linking source, instead of resolving each
// (source, target) edge again inside the association step. A dense vault where
// every source links to every requested target would otherwise issue ~sources×targets
// duplicate lookups.
test('resolves each incoming linking source once, not once per target', () => {
	const targets = Array.from({ length: 30 }, (_, i) => note(`t/note-${i}.md`));
	const sources = Array.from({ length: 60 }, (_, i) => note(`s/note-${i}.md`));
	const resolved = Object.fromEntries(sources.map((s) => [s.path, Object.fromEntries(targets.map((t) => [t.path, 1]))]));
	const byPath = new Map([...targets, ...sources].map((f) => [f.path, f]));
	let lookups = 0;
	const app = {
		metadataCache: { resolvedLinks: resolved },
		vault: { getAbstractFileByPath: (path) => { lookups++; return byPath.get(path) ?? null; } },
	};
	const result = getRelatedNotesForFiles(app, targets);
	assert.equal(result.length, targets.length * sources.length);
	assert.ok(lookups <= 60, `resolved ${lookups} paths; expected one resolve per linking source (60), not per edge (3660)`);
});

// Many selected sources often share the same targets (folders, MOCs). The
// vault lookup should run once per distinct path, not once per (source, target)
// pair, otherwise a 100×50 fan-out costs 5000 lookups instead of 50.
test('resolves each distinct target path once across many sources', () => {
	const sources = Array.from({ length: 100 }, (_, i) => note(`s/note-${i}.md`));
	const targets = Array.from({ length: 50 }, (_, i) => note(`t/note-${i}.md`));
	const resolved = Object.fromEntries(
		sources.map((s) => [s.path, Object.fromEntries(targets.map((t) => [t.path, 1]))]),
	);
	const byPath = new Map([...sources, ...targets].map((f) => [f.path, f]));
	let lookups = 0;
	const app = {
		metadataCache: { resolvedLinks: resolved },
		vault: { getAbstractFileByPath: (path) => { lookups++; return byPath.get(path) ?? null; } },
	};
	const result = getRelatedNotesForFiles(app, sources);
	assert.equal(result.length, sources.length * targets.length);
	assert.ok(lookups <= targets.length + 4, `resolved ${lookups} paths; expected one per distinct target (${targets.length})`);
});

// The incoming pass walks the whole resolved-link cache. Notes that never link
// to a requested source must not be resolved at all; otherwise a large vault
// pays one vault lookup per note even when only a handful are relevant.
test('skips resolving unrelated linking sources during the incoming pass', () => {
	const selected = note('sel/source.md');
	const linking = note('other/linker.md');
	const unrelatedTargets = Array.from({ length: 200 }, (_, i) => note(`far/t-${i}.md`));
	const unrelated = unrelatedTargets.map((target, i) => note(`other/u-${i}.md`));
	const resolved = {};
	resolved[linking.path] = { [selected.path]: 1 };
	for (let i = 0; i < unrelated.length; i++) {
		resolved[unrelated[i].path] = { [unrelatedTargets[i].path]: 1 };
	}
	const byPath = new Map([selected, linking, ...unrelated, ...unrelatedTargets].map((f) => [f.path, f]));
	let lookups = 0;
	const app = {
		metadataCache: { resolvedLinks: resolved },
		vault: { getAbstractFileByPath: (path) => { lookups++; return byPath.get(path) ?? null; } },
	};
	const result = getRelatedNotesForFiles(app, [selected]);
	assert.deepEqual(result.map((r) => [r.file.path, r.relation]), [[linking.path, 'incoming']]);
	assert.ok(lookups <= 4, `resolved ${lookups} paths; unrelated sources must not be resolved`);
});
