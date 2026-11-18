import test from 'node:test';
import assert from 'node:assert/strict';
import { runImageConversion } from '../src/image-convert/image-convert-runner.ts';
import { CanvasImageCodec, isWithinHardPixelLimit, isWithinPixelLimit, MAX_IMAGE_PIXELS, HARD_MAX_IMAGE_PIXELS } from '../src/image-convert/image-codec.ts';
import { normalizeImageConversionConfig } from '../src/cleanup/cleanup-types.ts';

/**
 * Guards for the whenToConvert strategy ('save-space' | 'always').
 * - save-space (default): skip when the converted file is not smaller (reason: larger-than-source).
 * - always: convert even when the result grows.
 * - Pixel tiers: soft limit 120M px (save-space), hard limit 400M px (always).
 *
 * The runner-level stub is self-contained (no global DOM stubs).
 * The codec-level tests install a local DOM stub and restore it in finally.
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

function makeApp({ noteContent = '![[a.png]]' } = {}) {
	const files = new Map();
	files.set('x.md', {
		path: 'x.md',
		extension: 'md',
		stat: { size: noteContent.length, mtime: 1 },
		content: noteContent,
		binary: encoder.encode(noteContent).buffer,
	});
	files.set('a.png', {
		path: 'a.png',
		extension: 'png',
		stat: { size: 100, mtime: 1 },
		content: '',
		binary: bytesOf(100),
	});
	const trashes = [];
	const caches = {
		'x.md': {
			embeds: [{
				link: 'a.png',
				original: '![[a.png]]',
				position: { start: { offset: 0 }, end: { offset: noteContent.length } },
			}],
			links: [],
		},
	};
	return {
		files,
		trashes,
		vault: {
			getFiles: () => [...files.values()],
			getFileByPath: (path) => files.get(path) ?? null,
			cachedRead: async (file) => file.content,
			read: async (file) => file.content,
			readBinary: async (file) => file.binary,
			process: async (file, change) => {
				const next = change(file.content);
				file.content = next;
				file.stat = { ...file.stat, size: next.length, mtime: file.stat.mtime + 1 };
				return next;
			},
			createBinary: async (path, data) => {
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
			resolvedLinks: { 'x.md': { 'a.png': 1 } },
			getFileCache: (file) => caches[file.path] ?? {},
			getFirstLinkpathDest: (link, sourcePath) => resolveLink(files, link, sourcePath),
		},
		fileManager: {
			trashFile: async (file) => {
				trashes.push(file.path);
				files.delete(file.path);
			},
		},
	};
}

/** Codec stub whose encoded output is deliberately LARGER than the source. */
function makeGrowingCodec() {
	const calls = { decodeOptions: [] };
	return {
		calls,
		decode: async (bytes, options) => {
			calls.decodeOptions.push(options);
			return { ok: true, image: { width: 10, height: 10, hasAlpha: false } };
		},
		encode: async () => ({ ok: true, bytes: bytesOf(200) }),
	};
}

test('whenToConvert=always converts even when the result is larger', async () => {
	const app = makeApp();
	const codec = makeGrowingCodec();
	const result = await runImageConversion(app, codec, [{ path: 'a.png', size: 100, mtime: 1 }], {
		target: 'webp',
		whenToConvert: 'always',
	});

	assert.equal(result.converted.length, 1, 'always strategy should convert a larger result');
	assert.equal(result.skipped.length, 0);
	assert.equal(result.failed.length, 0);
	assert.ok(app.trashes.includes('a.png'), 'original should be trashed');
	assert.ok(!app.files.has('a.png'));
	assert.ok(app.files.has('a.webp'), 'new file should exist');
	const note = app.files.get('x.md').content;
	assert.ok(note.includes('a.webp'), `note should be rewritten, got: ${note}`);
	assert.ok(!note.includes('![[a.png]]'), 'old reference should be gone');
	assert.equal(codec.calls.decodeOptions[0]?.whenToConvert, 'always', 'strategy should reach the codec');
});

test('whenToConvert=save-space skips a larger result and keeps the original', async () => {
	const app = makeApp();
	const codec = makeGrowingCodec();
	const result = await runImageConversion(app, codec, [{ path: 'a.png', size: 100, mtime: 1 }], {
		target: 'webp',
		whenToConvert: 'save-space',
	});

	assert.equal(result.converted.length, 0);
	assert.deepEqual(result.skipped.map((item) => item.reason), ['larger-than-source']);
	assert.ok(app.files.has('a.png'), 'original must be kept');
	assert.ok(!app.files.has('a.webp'), 'no new file should be created');
	assert.deepEqual(app.trashes, [], 'nothing should be trashed');
	assert.equal(app.files.get('x.md').content, '![[a.png]]', 'reference must stay untouched');
});

test('omitting whenToConvert behaves like save-space', async () => {
	const app = makeApp();
	const codec = makeGrowingCodec();
	const result = await runImageConversion(app, codec, [{ path: 'a.png', size: 100, mtime: 1 }], {
		target: 'webp',
	});

	assert.equal(result.converted.length, 0);
	assert.deepEqual(result.skipped.map((item) => item.reason), ['larger-than-source']);
	assert.ok(app.files.has('a.png'));
	assert.ok(!app.files.has('a.webp'));
});

// ---- codec pixel tiers ----

function installDomStub(dims) {
	const previous = {
		createEl: globalThis.createEl,
		createImageBitmap: globalThis.createImageBitmap,
		createObjectURL: URL.createObjectURL,
		revokeObjectURL: URL.revokeObjectURL,
	};
	class FakeImageBitmap {
		constructor() {
			this.width = dims.width;
			this.height = dims.height;
			this.closed = 0;
		}
		close() {
			this.closed += 1;
		}
	}
	class FakeCanvas {
		constructor() {
			this.width = 0;
			this.height = 0;
		}
		getContext() {
			return {
				fillStyle: '',
				drawImage: () => {},
				fillRect: () => {},
				getImageData: (x, y, width, height) => ({
					data: new Uint8ClampedArray(width * height * 4).fill(255),
				}),
			};
		}
	}
	globalThis.createEl = () => new FakeCanvas();
	globalThis.createImageBitmap = async () => new FakeImageBitmap();
	URL.createObjectURL = () => 'blob:test';
	URL.revokeObjectURL = () => {};
	return {
		restore() {
			if (previous.createEl === undefined) delete globalThis.createEl;
			else globalThis.createEl = previous.createEl;
			if (previous.createImageBitmap === undefined) delete globalThis.createImageBitmap;
			else globalThis.createImageBitmap = previous.createImageBitmap;
			URL.createObjectURL = previous.createObjectURL;
			URL.revokeObjectURL = previous.revokeObjectURL;
		},
	};
}

const bytes = () => new Uint8Array([1]).buffer;

test('pixel tiers: soft limit 120M, hard limit 400M', () => {
	assert.equal(MAX_IMAGE_PIXELS, 120_000_000);
	assert.equal(HARD_MAX_IMAGE_PIXELS, 400_000_000);
	assert.equal(isWithinPixelLimit(12_000, 10_000), true, 'exactly at the soft limit is allowed');
	assert.equal(isWithinPixelLimit(13_000, 10_000), false, 'above the soft limit is rejected');
	assert.equal(isWithinHardPixelLimit(13_000, 10_000), true, 'above soft but below hard is allowed by the hard limit');
	assert.equal(isWithinHardPixelLimit(30_000, 15_000), false, 'above the hard limit is rejected');
});

test('codec: save-space skips 130M px images, always allows them', async () => {
	const stub = installDomStub({ width: 13_000, height: 10_000 });
	try {
		const codec = new CanvasImageCodec();
		const saveSpace = await codec.decode(bytes(), { needAlpha: false, whenToConvert: 'save-space' });
		assert.equal(saveSpace.ok, false, 'save-space should reject 130M px');
		assert.equal(saveSpace.ok === false ? saveSpace.reasonId : undefined, 'pixel-limit');

		const always = await codec.decode(bytes(), { needAlpha: false, whenToConvert: 'always' });
		assert.equal(always.ok, true, 'always should allow 130M px');
	} finally {
		stub.restore();
	}
});

test('codec: always still rejects 450M px images by the hard limit', async () => {
	const stub = installDomStub({ width: 30_000, height: 15_000 });
	try {
		const codec = new CanvasImageCodec();
		const always = await codec.decode(bytes(), { needAlpha: false, whenToConvert: 'always' });
		assert.equal(always.ok, false, 'always must not exceed the hard limit');
		assert.equal(always.ok === false ? always.reasonId : undefined, 'pixel-limit');
	} finally {
		stub.restore();
	}
});

test('codec: omitting the strategy behaves like save-space', async () => {
	const stub = installDomStub({ width: 13_000, height: 10_000 });
	try {
		const codec = new CanvasImageCodec();
		const result = await codec.decode(bytes(), { needAlpha: false });
		assert.equal(result.ok, false, 'without a strategy the soft limit still applies');
		assert.equal(result.ok === false ? result.reasonId : undefined, 'pixel-limit');
	} finally {
		stub.restore();
	}
});

// ---- normalize fallbacks ----

test('normalizeImageConversionConfig: missing or illegal whenToConvert falls back to save-space', () => {
	assert.equal(normalizeImageConversionConfig({}).whenToConvert, 'save-space');
	assert.equal(normalizeImageConversionConfig({ whenToConvert: 'nope' }).whenToConvert, 'save-space');
	assert.equal(normalizeImageConversionConfig({ whenToConvert: null }).whenToConvert, 'save-space');
	assert.equal(normalizeImageConversionConfig({ whenToConvert: 1 }).whenToConvert, 'save-space');
	assert.equal(normalizeImageConversionConfig(undefined).whenToConvert, 'save-space');
	assert.equal(normalizeImageConversionConfig({ whenToConvert: 'always' }).whenToConvert, 'always');
	assert.equal(normalizeImageConversionConfig({ whenToConvert: 'save-space' }).whenToConvert, 'save-space');
});
