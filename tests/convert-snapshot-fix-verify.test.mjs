import test from 'node:test';
import assert from 'node:assert/strict';
import { runImageConversion } from '../src/image-convert/image-convert-runner.ts';

/**
 * Verification of the snapshot residual-reference fix.
 * Self-contained ConversionApp stub: no globalThis / DOM stubs, stable in full runs.
 *
 * Scenario A (red line): snapshot is built before conversion; mid-conversion an external
 * writer adds a reference from note Y to the old image. The original image MUST NOT be
 * trashed (rollback or skip must happen).
 * Scenario B (reverse, no false positive): inbound index reports a reference but the
 * content was already rewritten -> conversion proceeds and trashes the original.
 * Scenario C (perf guard): residual check must not do a full-vault read per image;
 * only suspicious paths (index says inbound but snapshot says no residual) are re-read.
 */

const encoder = new TextEncoder();
const bytesOf = (size) => new Uint8Array(size).buffer;

function normalize(path) {
	const parts = [];
	for (const part of path.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') parts.pop();
		else parts.push(part);
	}
	return parts.join('/');
}

function resolveLink(files, link, sourcePath) {
	const clean = link.trim().replace(/^<|>$/g, '').split('#')[0].split('?')[0];
	if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)) return null;
	const decoded = decodeURIComponent(clean);
	if (decoded.startsWith('/')) return files.get(decoded.slice(1)) ?? null;
	const directory = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
	const relative = normalize([directory, decoded].filter(Boolean).join('/'));
	if (files.has(relative)) return files.get(relative);
	if (files.has(decoded)) return files.get(decoded);
	const name = decoded.slice(decoded.lastIndexOf('/') + 1);
	const matches = [...files.values()].filter((file) => file.path.slice(file.path.lastIndexOf('/') + 1) === name);
	return matches.length === 1 ? matches[0] : null;
}

function makeApp({ notes = {}, images = {}, resolvedLinks = {}, caches = {} } = {}) {
	const files = new Map();
	for (const [path, content] of Object.entries(notes)) {
		files.set(path, {
			path,
			extension: path.split('.').at(-1).toLowerCase(),
			stat: { size: content.length, mtime: 1 },
			content,
			binary: encoder.encode(content).buffer,
		});
	}
	for (const [path, size] of Object.entries(images)) {
		files.set(path, {
			path,
			extension: path.split('.').at(-1).toLowerCase(),
			stat: { size, mtime: 1 },
			content: '',
			binary: bytesOf(size),
		});
	}
	const stats = { reads: [], trashes: [], created: [] };
	const links = { ...resolvedLinks };
	const app = {
		files,
		stats,
		links,
		vault: {
			getFiles: () => [...files.values()],
			getFileByPath: (path) => files.get(path) ?? null,
			cachedRead: async (file) => file.content,
			read: async (file) => {
				stats.reads.push(file.path);
				return file.content;
			},
			readBinary: async (file) => file.binary,
			process: async (file, change) => {
				const next = change(file.content);
				file.content = next;
				file.stat = { ...file.stat, size: next.length, mtime: file.stat.mtime + 1 };
				return next;
			},
			createBinary: async (path, data) => {
				stats.created.push(path);
				if (files.has(path)) throw new Error('already exists');
				const file = {
					path,
					extension: path.split('.').at(-1).toLowerCase(),
					stat: { size: data.byteLength, mtime: 1 },
					content: '',
					binary: data,
				};
				files.set(path, file);
				return file;
			},
			delete: async (file) => {
				files.delete(file.path);
			},
		},
		metadataCache: {
			resolvedLinks: links,
			getFileCache: (file) => caches[file.path] ?? {},
			getFirstLinkpathDest: (link, sourcePath) => resolveLink(files, link, sourcePath),
		},
		fileManager: {
			trashFile: async (file) => {
				stats.trashes.push(file.path);
				files.delete(file.path);
			},
		},
	};
	return app;
}

function makeCodec() {
	return {
		decode: async () => ({ ok: true, image: { width: 10, height: 10, hasAlpha: false } }),
		encode: async () => ({ ok: true, bytes: bytesOf(40) }),
	};
}

function embedsCache(content, links) {
	return {
		embeds: links.map((link) => {
			const original = `![[${link}]]`;
			const start = content.indexOf(original);
			return { link, original, position: { start: { offset: start }, end: { offset: start + original.length } } };
		}),
		links: [],
	};
}

test('scenario A: external reference added after snapshot must prevent trashing the original', async () => {
	const note = '![[a.png]]';
	const yNote = 'no reference yet';
	const app = makeApp({
		notes: { 'x.md': note, 'y.md': yNote },
		images: { 'a.png': 100 },
		resolvedLinks: { 'x.md': { 'a.png': 1 } },
		caches: {
			'x.md': embedsCache(note, ['a.png']),
			'y.md': { embeds: [], links: [] },
		},
	});

	// Inject the external write when the new file is being created (snapshot already built,
	// before trash). Update BOTH the note content and the inbound index, simulating Obsidian
	// having processed the external edit.
	let injected = false;
	const originalCreate = app.vault.createBinary;
	app.vault.createBinary = async (path, data) => {
		if (!injected && path === 'a.webp') {
			injected = true;
			const y = app.files.get('y.md');
			y.content = 'external edit: ![[a.png]]';
			y.stat = { size: y.content.length, mtime: 2 };
			app.links['y.md'] = { 'a.png': 1 };
		}
		return originalCreate(path, data);
	};

	const result = await runImageConversion(app, makeCodec(), [{ path: 'a.png', size: 100, mtime: 1 }], {
		target: 'webp',
	});

	assert.ok(injected, 'external write should have been injected');
	assert.ok(app.files.has('a.png'), 'original image must NOT be trashed when Y still references it');
	assert.ok(!app.stats.trashes.includes('a.png'), 'trashFile must not be called on a.png');
	const blocked = [...result.skipped, ...result.failed].some((entry) => /residual|残留/.test(entry.reason ?? ''));
	assert.ok(blocked, 'conversion should be blocked/skipped due to residual reference');
});

test('scenario A2: external reference added but inbound index NOT updated (index-lag edge)', async () => {
	const note = '![[a.png]]';
	const app = makeApp({
		notes: { 'x.md': note, 'y.md': 'no reference yet' },
		images: { 'a.png': 100 },
		resolvedLinks: { 'x.md': { 'a.png': 1 } },
		caches: { 'x.md': embedsCache(note, ['a.png']), 'y.md': { embeds: [], links: [] } },
	});
	let injected = false;
	const originalCreate = app.vault.createBinary;
	app.vault.createBinary = async (path, data) => {
		if (!injected && path === 'a.webp') {
			injected = true;
			const y = app.files.get('y.md');
			y.content = 'external edit: ![[a.png]]';
			y.stat = { size: y.content.length, mtime: 2 };
		}
		return originalCreate(path, data);
	};
	const result = await runImageConversion(app, makeCodec(), [{ path: 'a.png', size: 100, mtime: 1 }], {
		target: 'webp',
	});
	assert.ok(injected, 'external write should have been injected');
	assert.ok(
		!app.stats.trashes.includes('a.png'),
		'RED LINE: stale inbound index let external reference from Y slip through and a.png was trashed',
	);
});

test('scenario B: inbound index says referenced but content already rewritten -> normal trash', async () => {
	const note = '![[a.png]]';
	const app = makeApp({
		notes: { 'x.md': note },
		images: { 'a.png': 100 },
		// stale inbound index: still says x.md references a.png even though rewrite will change it
		resolvedLinks: { 'x.md': { 'a.png': 1 } },
		caches: { 'x.md': embedsCache(note, ['a.png']) },
	});

	const result = await runImageConversion(app, makeCodec(), [{ path: 'a.png', size: 100, mtime: 1 }], {
		target: 'webp',
	});

	assert.equal(result.converted.length, 1, 'conversion should succeed when content was truly rewritten');
	assert.ok(app.stats.trashes.includes('a.png'), 'original should be trashed when no real residual remains');
	assert.ok(!app.files.has('a.png'), 'original should be gone');
	assert.equal(result.skipped.length, 0);
	assert.equal(result.failed.length, 0);
});

test('scenario C: residual check re-reads disk only for suspicious paths, not every image', async () => {
	const notes = {};
	const resolvedLinks = {};
	const caches = {};
	const imageItems = [];
	for (let i = 0; i < 8; i += 1) {
		const name = `img${i}.png`;
		const content = `![[${name}]]`;
		notes[`note${i}.md`] = content;
		resolvedLinks[`note${i}.md`] = { [name]: 1 };
		caches[`note${i}.md`] = embedsCache(content, [name]);
		imageItems.push({ path: name, size: 100, mtime: 1 });
	}
	const app = makeApp({ notes, images: Object.fromEntries(imageItems.map((item) => [item.path, 100])), resolvedLinks, caches });

	const result = await runImageConversion(app, makeCodec(), imageItems, { target: 'webp' });

	assert.equal(result.converted.length, 8, 'all 8 images should convert');
	// After the initial snapshot + batch scan, each suspicious path may be re-read once for
	// residual confirmation. The guard: total read calls stay small and bounded, NOT one-full-
	// vault-scan per image (which would be 8 * 8 = 64 reads of note files).
	const noteReads = app.stats.reads.filter((path) => path.endsWith('.md'));
	assert.ok(
		noteReads.length <= 16,
		`residual checks must not re-read the whole vault per image; got ${noteReads.length} note reads`,
	);
});
