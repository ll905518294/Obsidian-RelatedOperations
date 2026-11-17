import test from 'node:test';
import assert from 'node:assert/strict';
import { runImageConversion } from '../src/image-convert/image-convert-runner.ts';

/**
 * Regression guard for the real-vault failure: "e.vault.getFiles is not a function".
 * Root cause previously: appWithSnapshot cloned the vault with object spread
 * ({...app.vault, read}), dropping prototype methods such as getFiles.
 *
 * The fix wraps with Object.create (preserving the prototype chain) and overrides read
 * with a closure that calls the original vault's read (correct `this`). appWithSnapshot
 * is NOT exported, so these tests exercise it indirectly through runImageConversion.
 *
 * Stub design: getFiles and read live on the prototype and read depends on `this`.
 * - If the prototype chain is lost -> `getFiles is not a function` -> conversion throws.
 * - If `this` is lost on the read fallback -> prototype `this` assertion throws.
 * - Snapshot-hit priority: the first read of x.md (snapshot build) returns content WITH
 *   the reference; later reads return content WITHOUT it. If the batch scan reads the
 *   real vault instead of the snapshot, it misses the site and the note is not rewritten.
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

class ProtoVault {
	constructor(files, stats) {
		this._files = files;
		this._stats = stats;
	}
	// Prototype method that depends on `this`.
	getFiles() {
		this._stats.getFilesCalls++;
		return [...this._files.values()];
	}
	getFileByPath(path) {
		return this._files.get(path) ?? null;
	}
	cachedRead(file) {
		return this._files.get(file.path).content;
	}
	// Prototype method that depends on `this` for both the guard and the lookup.
	read(file) {
		assert.ok(this instanceof ProtoVault, 'read must be called with the real vault as `this`');
		this._stats.realReads.push(file.path);
		const stored = this._files.get(file.path);
		if (!stored) throw new Error('read: file not found');
		return stored.content;
	}
	readBinary(file) {
		return this._files.get(file.path).binary;
	}
	process(file, change) {
		const next = change(file.content);
		file.content = next;
		file.stat = { ...file.stat, size: next.length, mtime: file.stat.mtime + 1 };
		return next;
	}
	createBinary(path, data) {
		if (this._files.has(path)) throw new Error('already exists');
		const file = {
			path,
			extension: path.split('.').at(-1).toLowerCase(),
			stat: { size: data.byteLength, mtime: 1 },
			content: '',
			binary: data,
		};
		this._files.set(path, file);
		return file;
	}
	delete(file) {
		this._files.delete(file.path);
	}
}

function makeApp({ firstReadContent = null } = {}) {
	const files = new Map();
	const stats = { getFilesCalls: 0, realReads: [] };
	const withRef = '![[a.png]]';
	const withoutRef = 'reference removed';
	files.set('x.md', {
		path: 'x.md',
		extension: 'md',
		stat: { size: withRef.length, mtime: 1 },
		content: withRef,
		binary: encoder.encode(withRef).buffer,
	});
	files.set('a.png', {
		path: 'a.png',
		extension: 'png',
		stat: { size: 100, mtime: 1 },
		content: '',
		binary: bytesOf(100),
	});

	const vault = new ProtoVault(files, stats);
	// Make real reads of x.md return a DIFFERENT (reference-free) value after the first read,
	// so a batch scan that bypasses the snapshot would miss the site.
	const originalRead = vault.read.bind(vault);
	let xReadCount = 0;
	vault.read = function readWithChangingContent(file) {
		assert.ok(this instanceof ProtoVault, 'read must be called with the real vault as `this`');
		if (file.path === 'x.md') {
			xReadCount++;
			stats.realReads.push(file.path);
			return xReadCount === 1 ? withRef : (firstReadContent ?? withoutRef);
		}
		return originalRead(file);
	};

	const caches = {
		'x.md': {
			embeds: [{ link: 'a.png', original: withRef, position: { start: { offset: 0 }, end: { offset: withRef.length } } }],
			links: [],
		},
	};
	return {
		files,
		stats,
		vault,
		metadataCache: {
			resolvedLinks: { 'x.md': { 'a.png': 1 } },
			getFileCache: (file) => caches[file.path] ?? {},
			getFirstLinkpathDest: (link, sourcePath) => resolveLink(files, link, sourcePath),
		},
		fileManager: {
			trashFile: (file) => {
				files.delete(file.path);
			},
		},
	};
}

function makeCodec() {
	return {
		decode: async () => ({ ok: true, image: { width: 10, height: 10, hasAlpha: false } }),
		encode: async () => ({ ok: true, bytes: bytesOf(40) }),
	};
}

test('prototype getFiles survives wrapping and snapshot read keeps correct this', async () => {
	const app = makeApp();
	const result = await runImageConversion(app, makeCodec(), [{ path: 'a.png', size: 100, mtime: 1 }], {
		target: 'webp',
	});

	assert.equal(result.converted.length, 1, 'conversion should succeed with prototype-based vault methods');
	assert.ok(app.stats.getFilesCalls > 0, 'prototype getFiles should have been called successfully');
	assert.ok(!app.files.has('a.png'), 'original image should be trashed after a clean conversion');
	assert.equal(result.failed.length, 0);
});

test('batch scan reads from snapshot, not the real vault (reference preserved)', async () => {
	const app = makeApp();
	const result = await runImageConversion(app, makeCodec(), [{ path: 'a.png', size: 100, mtime: 1 }], {
		target: 'webp',
	});

	// If the batch scan had bypassed the snapshot, the second real read of x.md would return
	// reference-free content, the site would be missed, and the note would stay unchanged.
	const note = app.files.get('x.md').content;
	assert.ok(note.includes('a.webp'), `note should be rewritten from snapshot content, got: ${note}`);
	assert.ok(!note.includes('![[a.png]]'), 'old reference should be gone from the rewritten note');
	assert.equal(result.converted.length, 1);
});
