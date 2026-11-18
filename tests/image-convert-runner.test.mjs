import test from 'node:test';
import assert from 'node:assert/strict';
import { runImageConversion } from '../src/image-convert/image-convert-runner.ts';

const encoder = new TextEncoder();
const bytesOf = (size) => new Uint8Array(size).buffer;

function span(content, original) {
	const start = content.indexOf(original);
	return { start: { offset: start }, end: { offset: start + original.length } };
}

function wikiCache(content, link) {
	const original = `![[${link}]]`;
	return {
		embeds: [{ link, original, position: span(content, original) }],
	};
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
	return matches.length === 1 ? matches[0] : matches[0] ?? null;
}

function normalize(path) {
	const parts = [];
	for (const part of path.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') parts.pop();
		else parts.push(part);
	}
	return parts.join('/');
}

function createApp({
	contents = {},
	binary = {},
	resolvedLinks = {},
	caches = {},
	createError = false,
	processError = null,
	trashError = false,
} = {}) {
	const files = new Map();
	for (const [path, content] of Object.entries(contents)) {
		files.set(path, {
			path,
			extension: path.split('.').at(-1).toLowerCase(),
			stat: { size: content.length, mtime: 1 },
			content,
			binary: encoder.encode(content).buffer,
		});
	}
	for (const [path, data] of Object.entries(binary)) {
		files.set(path, {
			path,
			extension: path.split('.').at(-1).toLowerCase(),
			stat: { size: data.byteLength, mtime: 1 },
			content: '',
			binary: data,
		});
	}
	let processCalls = 0;
	return {
		files,
		vault: {
			getFiles: () => [...files.values()],
			getFileByPath: (path) => files.get(path) ?? null,
			cachedRead: async (file) => file.content,
			read: async (file) => file.content,
			readBinary: async (file) => file.binary,
			process: async (file, change) => {
				processCalls++;
				if (processError?.(processCalls, file)) throw new Error('process boom');
				const next = change(file.content);
				file.content = next;
				file.stat = { ...file.stat, size: next.length, mtime: file.stat.mtime + 1 };
				return next;
			},
			createBinary: async (path, data) => {
				if (createError) throw new Error('create boom');
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
			resolvedLinks,
			getFileCache: (file) => caches[file.path] ?? {},
			getFirstLinkpathDest: (link, sourcePath) => resolveLink(files, link, sourcePath),
		},
		fileManager: {
			trashFile: async (file) => {
				if (trashError) throw new Error('trash boom');
				files.delete(file.path);
			},
		},
	};
}

function createCodec({ decoded = { width: 10, height: 10, hasAlpha: false }, output = bytesOf(40), decodeError, encodeError, decodeGate } = {}) {
	const calls = { decode: 0, encode: 0, encodeOptions: [] };
	return {
		calls,
		async decode(bytes, options) {
			calls.decode++;
			calls.decodeOptions ??= [];
			calls.decodeOptions.push(options);
			if (decodeGate) await decodeGate;
			if (decodeError) return { ok: false, reason: decodeError };
			return { ok: true, image: decoded };
		},
		async encode(image, target, options) {
			calls.encode++;
			calls.encodeOptions.push({ image, target, options: { ...options } });
			if (encodeError) return { ok: false, reason: encodeError };
			return { ok: true, bytes: output };
		},
	};
}

function notesApp({ notes, images, resolvedLinks, caches }) {
	return createApp({
		contents: notes,
		binary: Object.fromEntries(Object.entries(images).map(([path, size]) => [path, bytesOf(size)])),
		resolvedLinks,
		caches,
	});
}

test('converts one image, rewrites the note and trashes the original', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const codec = createCodec({ output: bytesOf(40) });
	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(result.converted.length, 1);
	assert.deepEqual(result.converted[0], {
		path: 'img.png',
		newPath: 'img.webp',
		oldBytes: 100,
		newBytes: 40,
	});
	assert.equal(result.savedBytes, 60);
	assert.equal(app.files.get('note.md').content, '![](<img.webp>)');
	assert.equal(app.files.has('img.png'), false);
	assert.equal(app.files.has('img.webp'), true);
});

test('preflights unsupported formats and decode failures before any write', async () => {
	const app = notesApp({
		notes: { 'note.md': '![[a.svg]]' },
		images: {},
		resolvedLinks: {},
		caches: {},
	});
	app.files.set('a.svg', {
		path: 'a.svg',
		extension: 'svg',
		stat: { size: 10, mtime: 1 },
		content: '<svg/>',
		binary: encoder.encode('<svg/>').buffer,
	});
	const codec = createCodec();
	const unsupported = await runImageConversion(app, codec, [{ path: 'a.svg', size: 10, mtime: 1 }], { target: 'webp' });
	assert.equal(unsupported.skipped[0].reason, 'unsupported-codec');
	assert.equal(codec.calls.decode, 0);
	assert.equal(app.files.get('note.md').content, '![[a.svg]]');

	const pngApp = notesApp({
		notes: { 'note.md': '![[img.png]]' },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache('![[img.png]]', 'img.png') },
	});
	const failedCodec = createCodec({ decodeError: '解码失败' });
	const failed = await runImageConversion(pngApp, failedCodec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(failed.skipped[0].reason, 'unsupported-codec');
	assert.match(failed.skipped[0].reasonText, /解码失败/);
	assert.equal(pngApp.files.has('img.webp'), false);
	assert.equal(pngApp.files.get('note.md').content, '![[img.png]]');
});

test('像素超限跳过记为 pixel-limit，其它解码失败记为 unsupported-codec', async () => {
	const note = '![[img.png]]';
	const makeApp = () => notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const pixelCodec = {
		decode: async () => ({ ok: false, reason: '图片尺寸 13000×10000 超过 1.2 亿像素上限', reasonId: 'pixel-limit' }),
		encode: async () => ({ ok: true, bytes: bytesOf(40) }),
	};
	const pixelApp = makeApp();
	const pixelResult = await runImageConversion(pixelApp, pixelCodec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(pixelResult.skipped[0].reason, 'pixel-limit');
	assert.match(pixelResult.skipped[0].reasonText, /1\.2 亿像素上限/);
	assert.equal(pixelApp.files.has('img.webp'), false);

	const genericCodec = {
		decode: async () => ({ ok: false, reason: '无法解码' }),
		encode: async () => ({ ok: true, bytes: bytesOf(40) }),
	};
	const genericApp = makeApp();
	const genericResult = await runImageConversion(genericApp, genericCodec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(genericResult.skipped[0].reason, 'unsupported-codec');
	assert.match(genericResult.skipped[0].reasonText, /无法解码/);
});

test('preflights encode failures and other unsupported source formats', async () => {
	const pngNote = '![[img.png]]';
	const pngApp = notesApp({
		notes: { 'note.md': pngNote },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(pngNote, 'img.png') },
	});
	const encodeFailure = await runImageConversion(
		pngApp,
		createCodec({ encodeError: '编码失败' }),
		[{ path: 'img.png', size: 100, mtime: 1 }],
		{ target: 'webp' },
	);
	assert.equal(encodeFailure.skipped[0].reason, 'unsupported-codec');
	assert.match(encodeFailure.skipped[0].reasonText, /编码失败/);
	assert.equal(pngApp.files.has('img.webp'), false);

	for (const extension of ['gif', 'tiff', 'heic']) {
		const path = `a.${extension}`;
		const app = createApp({
			contents: { 'note.md': `![[${path}]]` },
			binary: { [path]: bytesOf(10) },
			resolvedLinks: {},
			caches: {},
		});
		const codec = createCodec();
		const result = await runImageConversion(app, codec, [{ path, size: 10, mtime: 1 }], { target: 'webp' });
		assert.equal(result.skipped[0].reason, 'unsupported-codec', extension);
		assert.equal(codec.calls.decode, 0, extension);
		assert.equal(app.files.has('a.webp'), false, extension);
	}
});

test('[alpha] skips a transparent image before encoding when alpha=skip', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const codec = createCodec({ decoded: { width: 10, height: 10, hasAlpha: true } });
	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], {
		target: 'webp',
		alpha: 'skip',
	});
	assert.equal(result.skipped[0].reason, 'alpha-skip');
	assert.match(result.skipped[0].reasonText, /含透明通道/);
	assert.equal(codec.calls.decode, 1);
	assert.equal(codec.calls.encode, 0);
	assert.equal(app.files.has('img.png'), true);
	assert.equal(app.files.has('img.webp'), false);
	assert.equal(app.files.get('note.md').content, note);
});

test('[alpha] passes flatten=true for transparent WebP when alpha=flatten', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const codec = createCodec({
		decoded: { width: 10, height: 10, hasAlpha: true },
		output: bytesOf(40),
	});
	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], {
		target: 'webp',
		alpha: 'flatten',
	});
	assert.equal(result.converted.length, 1);
	assert.equal(codec.calls.encodeOptions[0].target, 'webp');
	assert.equal(codec.calls.encodeOptions[0].options.flatten, true);
});

test('[alpha] passes flatten=true for opaque WebP when alpha=flatten', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const codec = createCodec({
		decoded: { width: 10, height: 10, hasAlpha: false },
		output: bytesOf(40),
	});
	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], {
		target: 'webp',
		alpha: 'flatten',
	});
	assert.equal(result.converted.length, 1);
	assert.equal(codec.calls.encodeOptions[0].target, 'webp');
	assert.equal(codec.calls.encodeOptions[0].options.flatten, true);
});

test('[alpha] passes flatten=false for opaque WebP when alpha=skip', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const codec = createCodec({
		decoded: { width: 10, height: 10, hasAlpha: false },
		output: bytesOf(40),
	});
	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], {
		target: 'webp',
		alpha: 'skip',
	});
	assert.equal(result.converted.length, 1);
	assert.equal(codec.calls.encodeOptions[0].target, 'webp');
	assert.equal(codec.calls.encodeOptions[0].options.flatten, false);
});

test('[alpha] skips a transparent image for JPG target when alpha=skip', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const codec = createCodec({ decoded: { width: 10, height: 10, hasAlpha: true } });
	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], {
		target: 'jpg',
		alpha: 'skip',
	});
	assert.equal(result.skipped[0].reason, 'alpha-skip');
	assert.match(result.skipped[0].reasonText, /透明通道/);
	assert.equal(codec.calls.encode, 0);
	assert.equal(app.files.has('img.jpg'), false);
	assert.equal(app.files.get('note.md').content, note);
});

test('[alpha] passes flatten=true for transparent JPG when alpha=flatten', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const codec = createCodec({
		decoded: { width: 10, height: 10, hasAlpha: true },
		output: bytesOf(40),
	});
	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], {
		target: 'jpg',
		alpha: 'flatten',
	});
	assert.equal(result.converted.length, 1);
	assert.equal(codec.calls.encodeOptions[0].target, 'jpg');
	assert.equal(codec.calls.encodeOptions[0].options.flatten, true);
});

test('keeps the original and note untouched when creating the new file fails', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	app.vault.createBinary = async () => { throw new Error('create boom'); };
	const result = await runImageConversion(app, createCodec(), [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(result.failed[0].reason, 'create-failed');
	assert.equal(app.files.get('note.md').content, note);
	assert.equal(app.files.has('img.png'), true);
	assert.equal(app.files.has('img.webp'), false);
});

test('rejects every source in a batch that would write the same target', async () => {
	const app = createApp({
		contents: { 'note.md': '' },
		binary: { 'a.png': bytesOf(100), 'a.bmp': bytesOf(80) },
		resolvedLinks: {},
		caches: {},
	});
	const codec = createCodec();
	const result = await runImageConversion(
		app,
		codec,
		[
			{ path: 'a.png', size: 100, mtime: 1 },
			{ path: 'a.bmp', size: 80, mtime: 1 },
		],
		{ target: 'webp' },
	);
	assert.deepEqual(result.skipped.map((item) => item.path).sort(), ['a.bmp', 'a.png']);
	for (const item of result.skipped) assert.equal(item.reason, 'target-collision');
	assert.equal(codec.calls.decode, 0);
	assert.equal(app.files.has('a.webp'), false);
});

test('restores every note and deletes the new file when a later rewrite fails', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'a.md': note, 'b.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'a.md': { 'img.png': 1 }, 'b.md': { 'img.png': 1 } },
		caches: { 'a.md': wikiCache(note, 'img.png'), 'b.md': wikiCache(note, 'img.png') },
	});
	app.vault.process = (() => {
		let calls = 0;
		return async (file, change) => {
			calls++;
			if (calls === 2) throw new Error('process boom');
			const next = change(file.content);
			file.content = next;
			file.stat = { ...file.stat, size: next.length, mtime: file.stat.mtime + 1 };
			return next;
		};
	})();
	const result = await runImageConversion(app, createCodec({ output: bytesOf(40) }), [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(result.failed[0].reason, 'write-failed');
	assert.equal(app.files.get('a.md').content, note);
	assert.equal(app.files.get('b.md').content, note);
	assert.equal(app.files.has('img.png'), true);
	assert.equal(app.files.has('img.webp'), false);
});

test('fails the self-check and rolls back when the new path already appears in the note', async () => {
	const note = '![[img.png]]\n![[img.webp]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const result = await runImageConversion(app, createCodec({ output: bytesOf(40) }), [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(result.failed[0].reason, 'write-failed');
	assert.match(result.failed[0].reasonText, /新路径引用数量异常/);
	assert.equal(app.files.get('note.md').content, note);
	assert.equal(app.files.has('img.png'), true);
	assert.equal(app.files.has('img.webp'), false);
});

test('keeps rewritten references when trash fails and retries only trash on the next run', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	app.fileManager.trashFile = async () => { throw new Error('trash boom'); };
	const first = await runImageConversion(app, createCodec({ output: bytesOf(40) }), [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(first.failed[0].reason, 'trash-failed');
	assert.equal(first.failed[0].canRetryTrash, true);
	assert.deepEqual(first.pendingTrash, [{ path: 'img.png', newPath: 'img.webp' }]);
	assert.equal(app.files.get('note.md').content, '![](<img.webp>)');
	assert.equal(app.files.has('img.png'), true);
	assert.equal(app.files.has('img.webp'), true);

	app.fileManager.trashFile = async (file) => { app.files.delete(file.path); };
	const second = await runImageConversion(app, createCodec({ output: bytesOf(40) }), [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(second.converted.length, 1);
	assert.equal(app.files.has('img.png'), false);
	assert.equal(app.files.has('img.webp'), true);
	assert.equal(app.files.get('note.md').content, '![](<img.webp>)');
});

test('skips the image when resolved links and live references disagree', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 2 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const codec = createCodec();
	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(result.skipped[0].reason, 'count-mismatch');
	assert.equal(codec.calls.decode, 0);
	assert.equal(app.files.has('img.webp'), false);
});

test('skips wiki size references before decoding or writing', async () => {
	const note = '![[img.png|300]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const codec = createCodec();
	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(result.skipped[0].reason, 'has-size');
	assert.equal(codec.calls.decode, 0);
	assert.equal(app.files.get('note.md').content, note);
});

test('treats a case-variant target as an existing conflict', async () => {
	const app = createApp({
		contents: { 'note.md': '' },
		binary: { 'A.PNG': bytesOf(100), 'a.webp': bytesOf(10) },
		resolvedLinks: {},
		caches: {},
	});
	const codec = createCodec();
	const result = await runImageConversion(app, codec, [{ path: 'A.PNG', size: 100, mtime: 1 }], {
		target: 'webp',
		caseSensitive: false,
	});
	assert.equal(result.skipped[0].reason, 'target-exists');
	assert.equal(codec.calls.decode, 1);
	assert.equal(app.files.has('A.PNG'), true);
});

test('does not treat a case-variant target as a conflict on case-sensitive file systems', async () => {
	const app = createApp({
		contents: { 'note.md': '' },
		binary: { 'A.PNG': bytesOf(100), 'a.webp': bytesOf(10) },
		resolvedLinks: {},
		caches: {},
	});
	const result = await runImageConversion(app, createCodec({ output: bytesOf(40) }), [
		{ path: 'A.PNG', size: 100, mtime: 1 },
	], {
		target: 'webp',
		caseSensitive: true,
	});
	assert.equal(result.converted.length, 1);
	assert.equal(result.converted[0].newPath, 'A.webp');
	assert.equal(app.files.has('A.PNG'), false);
	assert.equal(app.files.has('A.webp'), true);
	assert.equal(app.files.has('a.webp'), true);
});

test('[B3] refuses to treat an unrelated existing target as a retry', async () => {
	const app = notesApp({
		notes: { 'note.md': '![[a.webp]]' },
		images: { 'a.png': 100 },
		resolvedLinks: { 'note.md': { 'a.webp': 1 } },
		caches: { 'note.md': wikiCache('![[a.webp]]', 'a.webp') },
	});
	const targetBytes = bytesOf(11);
	app.files.set('a.webp', {
		path: 'a.webp',
		extension: 'webp',
		stat: { size: targetBytes.byteLength, mtime: 1 },
		content: '',
		binary: targetBytes,
	});
	const result = await runImageConversion(app, createCodec({ output: bytesOf(22) }), [
		{ path: 'a.png', size: 100, mtime: 1 },
	], { target: 'webp' });
	assert.equal(result.skipped[0].reason, 'target-exists');
	assert.equal(app.files.has('a.png'), true);
	assert.equal(app.files.get('a.webp').binary, targetBytes);
});

test('[B3] treats a byte-identical target as the previous interrupted retry', async () => {
	const targetBytes = bytesOf(40);
	const app = notesApp({
		notes: { 'note.md': '![[a.webp]]' },
		images: { 'a.png': 100 },
		resolvedLinks: { 'note.md': { 'a.webp': 1 } },
		caches: { 'note.md': wikiCache('![[a.webp]]', 'a.webp') },
	});
	app.files.set('a.webp', {
		path: 'a.webp',
		extension: 'webp',
		stat: { size: targetBytes.byteLength, mtime: 1 },
		content: '',
		binary: targetBytes,
	});
	const result = await runImageConversion(app, createCodec({ output: targetBytes }), [
		{ path: 'a.png', size: 100, mtime: 1 },
	], { target: 'webp' });
	assert.equal(result.converted.length, 1);
	assert.equal(app.files.has('a.png'), false);
	assert.equal(app.files.get('a.webp').binary, targetBytes);
});

test('[B5] 编码结果大于原图时保留原图：不产出新文件、不改写引用', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	// 模拟 CAD 线稿 PNG 转 JPG：体积从 100 B 涨到 500 B。
	const result = await runImageConversion(app, createCodec({ output: bytesOf(500) }), [
		{ path: 'img.png', size: 100, mtime: 1 },
	], { target: 'jpg' });

	assert.equal(result.converted.length, 0, '体积变大不得计入转换成功');
	assert.equal(result.failed.length, 0);
	assert.equal(result.skipped.length, 1);
	assert.equal(result.skipped[0].reason, 'larger-than-source');
	assert.match(result.skipped[0].reasonText, /转换为 JPG 后体积不减反增/);
	assert.match(result.skipped[0].reasonText, /原始 100 B/);
	assert.match(result.skipped[0].reasonText, /转换后 500 B/);
	assert.match(result.skipped[0].reasonText, /已保留原图未做转换/);
	assert.equal(app.files.has('img.webp'), false, '不得留下新文件');
	assert.equal(app.files.has('img.jpg'), false, '不得留下新文件');
	assert.equal(app.files.get('note.md').content, note, '引用不得被改写');
	assert.equal(app.files.has('img.png'), true, '原图必须保留');
});

test('[B6] 编码结果等于原图体积时同样保留原图', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const result = await runImageConversion(app, createCodec({ output: bytesOf(100) }), [
		{ path: 'img.png', size: 100, mtime: 1 },
	], { target: 'jpg' });

	assert.equal(result.converted.length, 0);
	assert.equal(result.skipped[0].reason, 'larger-than-source');
	assert.equal(app.files.has('img.jpg'), false);
	assert.equal(app.files.get('note.md').content, note);
	assert.equal(app.files.has('img.png'), true);
});

test('[B7] 目标文件已存在且转换后更大时，不移入回收站原图', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const targetBytes = bytesOf(500);
	app.files.set('img.webp', {
		path: 'img.webp',
		extension: 'webp',
		stat: { size: targetBytes.byteLength, mtime: 1 },
		content: '',
		binary: targetBytes,
	});
	const result = await runImageConversion(app, createCodec({ output: bytesOf(500) }), [
		{ path: 'img.png', size: 100, mtime: 1 },
	], { target: 'webp' });

	assert.equal(result.converted.length, 0);
	assert.equal(result.skipped[0].reason, 'larger-than-source');
	assert.equal(app.files.has('img.png'), true, '体积变大时不得把原图移入回收站');
	assert.equal(app.files.get('note.md').content, note);
});

test('[B4] rollback preserves concurrent user edits and reports unrestored notes', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'a.md': note, 'b.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'a.md': { 'img.png': 1 }, 'b.md': { 'img.png': 1 } },
		caches: { 'a.md': wikiCache(note, 'img.png'), 'b.md': wikiCache(note, 'img.png') },
	});
	app.vault.process = (() => {
		let calls = 0;
		return async (file, change) => {
			calls++;
			if (calls === 2) {
				app.files.get('a.md').content = '用户刚刚写入的新内容';
				throw new Error('process boom');
			}
			const next = change(file.content);
			file.content = next;
			file.stat = { ...file.stat, size: next.length, mtime: file.stat.mtime + 1 };
			return next;
		};
	})();
	const result = await runImageConversion(app, createCodec({ output: bytesOf(40) }), [
		{ path: 'img.png', size: 100, mtime: 1 },
	], { target: 'webp' });
	assert.equal(result.failed[0].reason, 'write-failed');
	assert.equal(app.files.get('a.md').content, '用户刚刚写入的新内容');
	assert.deepEqual(result.unrestored, ['a.md']);
});

test('[B5] keeps the new file when rollback itself fails', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'a.md': note, 'b.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'a.md': { 'img.png': 1 }, 'b.md': { 'img.png': 1 } },
		caches: { 'a.md': wikiCache(note, 'img.png'), 'b.md': wikiCache(note, 'img.png') },
	});
	app.vault.process = (() => {
		let calls = 0;
		return async (file, change) => {
			calls++;
			if (calls === 2) throw new Error('rewrite boom');
			if (calls === 3) throw new Error('restore boom');
			const next = change(file.content);
			file.content = next;
			file.stat = { ...file.stat, size: next.length, mtime: file.stat.mtime + 1 };
			return next;
		};
	})();
	const result = await runImageConversion(app, createCodec({ output: bytesOf(40) }), [
		{ path: 'img.png', size: 100, mtime: 1 },
	], { target: 'webp' });
	assert.equal(result.failed[0].reason, 'write-failed');
	assert.equal(result.keptNewFile, true);
	assert.match(result.failed[0].reasonText, /已保留新文件/);
	assert.equal(app.files.has('img.webp'), true);
});

test('[B6] rechecks the source before trash and rolls back when it changed', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const originalProcess = app.vault.process;
	let changed = false;
	app.vault.process = async (file, change) => {
		const next = await originalProcess(file, change);
		if (!changed && file.path === 'note.md') {
			changed = true;
			app.files.get('img.png').stat.mtime += 1;
		}
		return next;
	};
	const result = await runImageConversion(app, createCodec({ output: bytesOf(40) }), [
		{ path: 'img.png', size: 100, mtime: 1 },
	], { target: 'webp' });
	assert.equal(result.skipped[0].reason, 'source-changed');
	assert.equal(app.files.has('img.png'), true);
	assert.equal(app.files.get('note.md').content, note);
	assert.equal(app.files.has('img.webp'), false);
});

test('[B7] rejects a residual raw reference that the parser does not recognize', async () => {
	const note = '残留路径 Attachments%2Fimg.png 不是链接';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'Attachments/img.png': 100 },
		resolvedLinks: {},
		caches: { 'note.md': {} },
	});
	const result = await runImageConversion(app, createCodec({ output: bytesOf(40) }), [
		{ path: 'Attachments/img.png', size: 100, mtime: 1 },
	], { target: 'webp' });
	assert.equal(result.skipped[0].reason, 'residual-reference');
	assert.equal(app.files.has('Attachments/img.png'), true);
	assert.equal(app.files.get('note.md').content, note);
	assert.equal(app.files.has('Attachments/img.webp'), false);
});

test('[B7] skips picture/source markup with zero writes', async () => {
	const note = '<picture><source src="img.png"><img src="img.png"></picture>';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': {} },
	});
	const result = await runImageConversion(app, createCodec(), [
		{ path: 'img.png', size: 100, mtime: 1 },
	], { target: 'webp' });
	assert.equal(result.skipped[0].reason, 'html-source');
	assert.equal(app.files.has('img.png'), true);
	assert.equal(app.files.get('note.md').content, note);
	assert.equal(app.files.has('img.webp'), false);
});

test('[B7] skips CSS url() references with zero writes', async () => {
	const note = '<style>.cover { background-image: url("img.png"); }</style>';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: {},
		caches: { 'note.md': {} },
	});
	const result = await runImageConversion(app, createCodec(), [
		{ path: 'img.png', size: 100, mtime: 1 },
	], { target: 'webp' });
	assert.equal(result.skipped[0].reason, 'css-url');
	assert.equal(app.files.has('img.png'), true);
	assert.equal(app.files.get('note.md').content, note);
	assert.equal(app.files.has('img.webp'), false);
});

test('[B7] skips Excalidraw code-block references with zero writes', async () => {
	const note = '```md\n![[img.png]]\n```\n';
	const app = notesApp({
		notes: { 'draw.excalidraw.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: {},
		caches: { 'draw.excalidraw.md': {} },
	});
	const result = await runImageConversion(app, createCodec(), [
		{ path: 'img.png', size: 100, mtime: 1 },
	], { target: 'webp' });
	assert.equal(result.skipped[0].reason, 'code-block-reference');
	assert.equal(app.files.has('img.png'), true);
	assert.equal(app.files.get('draw.excalidraw.md').content, note);
	assert.equal(app.files.has('img.webp'), false);
});

test('rewrites HTML src when the index counts it as a live reference', async () => {
	const note = '<img src="img.png" width="10">';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': {} },
	});
	const result = await runImageConversion(app, createCodec({ output: bytesOf(40) }), [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(result.converted.length, 1);
	assert.equal(app.files.get('note.md').content, '<img src="img.webp" width="10">');
});

test('blocks plain frontmatter paths and keeps the note unchanged', async () => {
	const note = '---\ncover: img.png\n---\n';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': {} },
	});
	const result = await runImageConversion(app, createCodec(), [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(result.skipped[0].reason, 'frontmatter-plain-path');
	assert.equal(app.files.get('note.md').content, note);
	assert.equal(app.files.has('img.webp'), false);
});

test('rewrites a quoted frontmatter wiki link and keeps YAML structure', async () => {
	const note = '---\ncover: "[[img.png]]"\n---\n';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: {
			'note.md': {
				frontmatterLinks: [{ key: 'cover', link: 'img.png', original: 'img.png' }],
			},
		},
	});
	const result = await runImageConversion(app, createCodec({ output: bytesOf(40) }), [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(result.converted.length, 1);
	assert.equal(app.files.get('note.md').content, '---\ncover: "[[img.webp]]"\n---\n');
});

test('skips srcset references before decoding or writing', async () => {
	const note = '<img src="img.png" srcset="img.png 1x, img@2x.png 2x">';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': {} },
	});
	const codec = createCodec();
	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(result.skipped[0].reason, 'srcset');
	assert.equal(codec.calls.decode, 0);
	assert.equal(app.files.get('note.md').content, note);
});

test('returns busy immediately when another conversion is running', async () => {
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const codec = createCodec({ decodeGate: gate, output: bytesOf(40) });
	const first = runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	await new Promise((resolve) => setTimeout(resolve, 0));
	const second = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(second.blockedReason, 'busy');
	assert.match(second.reasonText, /已有转换任务在进行/);
	release();
	assert.equal((await first).converted.length, 1);
});

test('reports progress in order and supports abort before the first item', async () => {
	const noteA = '![[a.png]]';
	const noteB = '![[b.png]]';
	const app = notesApp({
		notes: { 'a.md': noteA, 'b.md': noteB },
		images: { 'a.png': 100, 'b.png': 100 },
		resolvedLinks: { 'a.md': { 'a.png': 1 }, 'b.md': { 'b.png': 1 } },
		caches: { 'a.md': wikiCache(noteA, 'a.png'), 'b.md': wikiCache(noteB, 'b.png') },
	});
	const progress = [];
	const result = await runImageConversion(
		app,
		createCodec({ output: bytesOf(40) }),
		[{ path: 'a.png', size: 100, mtime: 1 }, { path: 'b.png', size: 100, mtime: 1 }],
		{ target: 'webp' },
		(processed, total, currentPath) => progress.push({ processed, total, currentPath }),
	);
	assert.equal(result.converted.length, 2);
	assert.equal(progress.length, 2);
	assert.deepEqual(progress.at(-1), { processed: 2, total: 2, currentPath: progress.at(-1).currentPath });

	const controller = new AbortController();
	controller.abort();
	const aborted = await runImageConversion(
		app,
		createCodec(),
		[{ path: 'a.png', size: 100, mtime: 1 }],
		{ target: 'webp', signal: controller.signal },
	);
	assert.equal(aborted.aborted, true);
	assert.equal(aborted.converted.length, 0);
});

test('转换成功后释放解码资源，编码失败时也释放', async () => {
	const app = notesApp({
		notes: { 'note.md': '![[img.png]]' },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache('![[img.png]]', 'img.png') },
	});
	const released = [];
	const codec = {
		async decode() {
			return { ok: true, image: { width: 10, height: 10, hasAlpha: false, source: {} } };
		},
		async encode() {
			return { ok: true, bytes: bytesOf(40) };
		},
		release(image) {
			released.push(image);
		},
	};
	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(result.converted.length, 1);
	assert.equal(released.length, 1);

	const failApp = notesApp({
		notes: { 'note.md': '![[other.png]]' },
		images: { 'other.png': 100 },
		resolvedLinks: { 'note.md': { 'other.png': 1 } },
		caches: { 'note.md': wikiCache('![[other.png]]', 'other.png') },
	});
	let failReleases = 0;
	const failCodec = {
		async decode() {
			return { ok: true, image: { width: 10, height: 10, hasAlpha: false, source: {} } };
		},
		async encode() {
			return { ok: false, reason: '编码失败' };
		},
		release() {
			failReleases += 1;
		},
	};
	const failed = await runImageConversion(failApp, failCodec, [{ path: 'other.png', size: 100, mtime: 1 }], { target: 'webp' });
	assert.equal(failed.skipped[0].reason, 'unsupported-codec');
	assert.equal(failReleases, 1);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pipelineCodec(options = {}) {
	let active = 0;
	const state = { peak: 0, releases: 0 };
	return {
		state,
		async decode() {
			active += 1;
			state.peak = Math.max(state.peak, active);
			await sleep(options.decodeMs ?? 5);
			return { ok: true, image: { width: 10, height: 10, hasAlpha: false, source: {} } };
		},
		async encode() {
			await sleep(options.encodeMs ?? 2);
			return { ok: true, bytes: bytesOf(40) };
		},
		release() {
			active -= 1;
			state.releases += 1;
		},
	};
}

test('互不引用的多图转换默认跑满 8 路并发，且每张只释放一次', async () => {
	const images = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`img/${index}.png`, 100]));
	const app = notesApp({ notes: {}, images });
	const codec = pipelineCodec();
	const items = Object.keys(images).map((path) => ({ path, size: 100, mtime: 1 }));

	const result = await runImageConversion(app, codec, items, { target: 'webp' });

	assert.equal(result.converted.length, 8);
	assert.equal(codec.state.peak, 8);
	assert.equal(codec.state.releases, 8);
});

test('4MB 阈值分 lane：>=4MB 单并发，<4MB 仍并发', async () => {
	const bigBytes = { 'large/a.png': 4 * 1024 * 1024, 'large/b.png': 4 * 1024 * 1024 };
	const bigApp = notesApp({ notes: {}, images: bigBytes });
	const bigCodec = pipelineCodec();
	const bigItems = Object.entries(bigBytes).map(([path, size]) => ({ path, size, mtime: 1 }));

	const bigResult = await runImageConversion(bigApp, bigCodec, bigItems, { target: 'webp' });

	assert.equal(bigResult.converted.length, 2);
	assert.equal(bigCodec.state.peak, 1, '>=4MB 应进入单并发通道');
	assert.equal(bigCodec.state.releases, 2);

	const smallSize = 4 * 1024 * 1024 - 1;
	const smallBytes = Object.fromEntries(
		Array.from({ length: 4 }, (_, index) => [`small/${index}.png`, smallSize]),
	);
	const smallApp = notesApp({ notes: {}, images: smallBytes });
	const smallCodec = pipelineCodec();
	const smallItems = Object.entries(smallBytes).map(([path, size]) => ({ path, size, mtime: 1 }));

	const smallResult = await runImageConversion(smallApp, smallCodec, smallItems, { target: 'webp' });

	assert.equal(smallResult.converted.length, 4);
	assert.equal(smallCodec.state.peak, 4, '<4MB 应留在并发通道');
});

test('并发可通过 options.concurrency 调整且不超过默认上限', async () => {
	const images = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`img/${index}.png`, 100]));
	const app = notesApp({ notes: {}, images });
	const codec = pipelineCodec();
	const items = Object.keys(images).map((path) => ({ path, size: 100, mtime: 1 }));

	await runImageConversion(app, codec, items, { target: 'webp', concurrency: 3 });

	assert.equal(codec.state.peak, 3);
});

test('多张图片只批量扫描一次引用笔记', async () => {
	const note = '![[a.png]]\n![[b.png]]\n![[c.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'a.png': 100, 'b.png': 100, 'c.png': 100 },
		resolvedLinks: { 'note.md': { 'a.png': 1, 'b.png': 1, 'c.png': 1 } },
		caches: { 'note.md': {
			embeds: [
				{ link: 'a.png', original: '![[a.png]]', position: span(note, '![[a.png]]') },
				{ link: 'b.png', original: '![[b.png]]', position: span(note, '![[b.png]]', note.indexOf('![[b.png]]')) },
				{ link: 'c.png', original: '![[c.png]]', position: span(note, '![[c.png]]', note.indexOf('![[c.png]]')) },
			],
			links: [],
		} },
	});
	const reads = [];
	let scanning = true;
	const read = app.vault.read;
	app.vault.read = async (file) => {
		if (scanning && file.path === 'note.md') reads.push(file.path);
		return read(file);
	};
	const codec = createCodec();
	const decode = codec.decode.bind(codec);
	codec.decode = async (...args) => {
		scanning = false;
		return decode(...args);
	};
	const items = ['a.png', 'b.png', 'c.png'].map((path) => ({ path, size: 100, mtime: 1 }));

	const result = await runImageConversion(app, codec, items, { target: 'webp' });

	assert.equal(result.converted.length, 3);
	assert.equal(reads.length, 1, `引用笔记只应读取一次，实际 ${reads.length} 次`);
	assert.equal(app.files.get('note.md').content, '![](<a.webp>)\n![](<b.webp>)\n![](<c.webp>)');
});

test('decode 按 alpha 设置传入 needAlpha', async () => {
	const app = notesApp({ notes: {}, images: { 'img.png': 100 } });
	const codec = createCodec();
	const items = [{ path: 'img.png', size: 100, mtime: 1 }];

	await runImageConversion(app, codec, items, { target: 'webp', alpha: 'skip' });
	assert.deepEqual(codec.calls.decodeOptions[0], { needAlpha: true });

	const flattenApp = notesApp({ notes: {}, images: { 'img.png': 100 } });
	const flattenCodec = createCodec();
	await runImageConversion(flattenApp, flattenCodec, items, { target: 'webp', alpha: 'flatten' });
	assert.deepEqual(flattenCodec.calls.decodeOptions[0], { needAlpha: false });
});

test('批量扫描开始前已中止时跳过全库扫描与解码', async () => {
	const app = notesApp({
		notes: { 'note.md': '![[img.png]]' },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache('![[img.png]]', 'img.png') },
	});
	const reads = [];
	const read = app.vault.read;
	app.vault.read = async (file) => {
		reads.push(file.path);
		return read(file);
	};
	const codec = createCodec();
	const controller = new AbortController();
	controller.abort();

	const result = await runImageConversion(
		app,
		codec,
		[{ path: 'img.png', size: 100, mtime: 1 }],
		{ target: 'webp', signal: controller.signal },
	);

	assert.equal(result.aborted, true);
	assert.deepEqual(reads, []);
	assert.equal(codec.calls.decode, 0);
});

test('转换开始时只建立一次引用内容快照', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const noteReads = [];
	const read = app.vault.read;
	let scanning = true;
	app.vault.read = async (file) => {
		if (scanning && file.path === 'note.md') noteReads.push(file.path);
		return read(file);
	};
	const codec = createCodec();
	const decode = codec.decode.bind(codec);
	codec.decode = async (...args) => {
		scanning = false;
		return decode(...args);
	};

	await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });

	assert.deepEqual(noteReads, ['note.md'], '批量扫描与内容快照应共享同一次笔记读取');
});

test('trash 前残留检查不再读取笔记', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const reads = [];
	const read = app.vault.read;
	let converting = false;
	app.vault.read = async (file) => {
		if (file.path === 'note.md') reads.push(converting ? 'rewrite' : 'scan');
		return read(file);
	};
	const codec = createCodec();
	const decode = codec.decode.bind(codec);
	codec.decode = async (...args) => {
		converting = true;
		delete app.metadataCache.resolvedLinks['note.md']['img.png'];
		return decode(...args);
	};

	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });

	assert.equal(result.converted.length, 1);
	assert.deepEqual(reads, ['scan'], '索引无 inbound 时，改写校验与 trash 前检查都从快照读取');
});

test('改写后快照同步，残留检查能看到已改写内容', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const codec = createCodec();

	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });

	assert.equal(result.converted.length, 1);
	assert.equal(result.failed.length, 0);
	assert.equal(app.files.has('img.png'), false, '残留检查应看到已改写内容，允许删除原图');
	assert.equal(app.files.get('note.md').content, '![](<img.webp>)');
});

test('回滚后快照恢复，后续残留检查仍准确', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, 'img.png') },
	});
	const codec = createCodec({ encodeError: '编码失败' });

	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], { target: 'webp' });

	assert.equal(result.converted.length, 0);
	assert.equal(app.files.get('note.md').content, note, '编码失败发生在改写前，笔记不得变化');
	assert.equal(app.files.has('img.png'), true);
});

test('vaultPaths 枚举次数不随引用站点数增长', async () => {
	const note = '![[a.png]]\n![[b.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'a.png': 100, 'b.png': 100 },
		resolvedLinks: { 'note.md': { 'a.png': 1, 'b.png': 1 } },
		caches: { 'note.md': {
			embeds: [
				{ link: 'a.png', original: '![[a.png]]', position: span(note, '![[a.png]]') },
				{ link: 'b.png', original: '![[b.png]]', position: span(note, '![[b.png]]', note.indexOf('![[b.png]]')) },
			],
			links: [],
		} },
	});
	let enumerations = 0;
	const getFiles = app.vault.getFiles;
	app.vault.getFiles = () => {
		enumerations += 1;
		return getFiles();
	};
	const codec = createCodec();
	const items = ['a.png', 'b.png'].map((path) => ({ path, size: 100, mtime: 1 }));

	const result = await runImageConversion(app, codec, items, { target: 'webp' });
	const twoSites = enumerations;

	const threeNote = '![[a.png]]\n![[b.png]]\n![[c.png]]';
	const threeApp = notesApp({
		notes: { 'note.md': threeNote },
		images: { 'a.png': 100, 'b.png': 100, 'c.png': 100 },
		resolvedLinks: { 'note.md': { 'a.png': 1, 'b.png': 1, 'c.png': 1 } },
		caches: { 'note.md': {
			embeds: [
				{ link: 'a.png', original: '![[a.png]]', position: span(threeNote, '![[a.png]]') },
				{ link: 'b.png', original: '![[b.png]]', position: span(threeNote, '![[b.png]]', threeNote.indexOf('![[b.png]]')) },
				{ link: 'c.png', original: '![[c.png]]', position: span(threeNote, '![[c.png]]', threeNote.indexOf('![[c.png]]')) },
			],
			links: [],
		} },
	});
	let threeEnumerations = 0;
	const threeGetFiles = threeApp.vault.getFiles;
	threeApp.vault.getFiles = () => {
		threeEnumerations += 1;
		return threeGetFiles();
	};
	const threeResult = await runImageConversion(
		threeApp,
		createCodec(),
		['a.png', 'b.png', 'c.png'].map((path) => ({ path, size: 100, mtime: 1 })),
		{ target: 'webp' },
	);

	assert.equal(result.converted.length, 2);
	assert.equal(threeResult.converted.length, 3);
	assert.ok(threeEnumerations <= twoSites + 1, `站点数增加不应线性增加 getFiles 枚举次数（2 站 ${twoSites}，3 站 ${threeEnumerations}）`);
});

test('快照建立后外部新增旧图引用时必须阻止删除原图', async () => {
	const note = '![[a.png]]';
	const app = notesApp({
		notes: {
			'note.md': note,
			'y.md': ' unrelated note ',
		},
		images: { 'a.png': 100 },
		resolvedLinks: { 'note.md': { 'a.png': 1 }, 'y.md': {} },
		caches: { 'note.md': wikiCache(note, 'a.png') },
	});
	const codec = createCodec();
	const decode = codec.decode.bind(codec);
	codec.decode = async (...args) => {
		const y = app.files.get('y.md');
		y.content = '外部新增：![[a.png]]';
		app.metadataCache.resolvedLinks['y.md'] = { 'a.png': 1 };
		return decode(...args);
	};

	const result = await runImageConversion(app, codec, [{ path: 'a.png', size: 100, mtime: 1 }], { target: 'webp' });

	assert.equal(result.converted.length, 0, '存在外部新增引用时不得计入转换成功');
	assert.equal(result.skipped[0]?.reason, 'residual-reference');
	assert.equal(app.files.has('a.png'), true, '残留引用未清除时必须保留原图');
	assert.equal(app.files.has('a.webp'), false, '回滚必须删除新建图片');
	assert.equal(app.files.get('note.md').content, note, '回滚必须恢复被改写的笔记');
});

test('索引没有 inbound 链接时 trash 前不额外读盘', async () => {
	const note = '![[a.png]]';
	const app = notesApp({
		notes: { 'note.md': note, 'y.md': ' unrelated note ' },
		images: { 'a.png': 100 },
		resolvedLinks: { 'note.md': { 'a.png': 1 }, 'y.md': {} },
		caches: { 'note.md': wikiCache(note, 'a.png') },
	});
	const codec = createCodec();
	const decode = codec.decode.bind(codec);
	let converting = false;
	const laterReads = [];
	const read = app.vault.read;
	app.vault.read = async (file) => {
		if (converting) laterReads.push(file.path);
		return read(file);
	};
	codec.decode = async (...args) => {
		converting = true;
		delete app.metadataCache.resolvedLinks['note.md']['a.png'];
		return decode(...args);
	};

	const result = await runImageConversion(app, codec, [{ path: 'a.png', size: 100, mtime: 1 }], { target: 'webp' });

	assert.equal(result.converted.length, 1);
	assert.deepEqual(laterReads, [], '索引无 inbound 时不应有额外真读盘');
	assert.equal(app.files.has('a.png'), false);
});

test('索引有 inbound 但真读盘确认已改写时仍允许删除', async () => {
	const note = '![[a.png]]';
	const app = notesApp({
		notes: { 'note.md': note, 'y.md': '![[a.webp]]' },
		images: { 'a.png': 100 },
		resolvedLinks: { 'note.md': { 'a.png': 1 }, 'y.md': {} },
		caches: { 'note.md': wikiCache(note, 'a.png') },
	});
	const yReads = [];
	let converting = false;
	const read = app.vault.read;
	app.vault.read = async (file) => {
		if (converting && file.path === 'y.md') yReads.push(file.path);
		return read(file);
	};
	const codec = createCodec();
	const decode = codec.decode.bind(codec);
	codec.decode = async (...args) => {
		converting = true;
		app.metadataCache.resolvedLinks['y.md'] = { 'a.png': 1 };
		return decode(...args);
	};

	const result = await runImageConversion(app, codec, [{ path: 'a.png', size: 100, mtime: 1 }], { target: 'webp' });

	assert.equal(result.converted.length, 1);
	assert.deepEqual(yReads, ['y.md'], '可疑源笔记必须真读盘复核');
	assert.equal(app.files.has('a.png'), false, '复核确认无残留后允许删除原图');
});

test('外部修改 stat 但索引未更新时也要真读盘并阻止删除', async () => {
	const note = '![[a.png]]';
	const app = notesApp({
		notes: {
			'note.md': note,
			'y.md': ' unrelated note ',
		},
		images: { 'a.png': 100 },
		resolvedLinks: { 'note.md': { 'a.png': 1 }, 'y.md': {} },
		caches: { 'note.md': wikiCache(note, 'a.png') },
	});
	const codec = createCodec();
	const decode = codec.decode.bind(codec);
	codec.decode = async (...args) => {
		const y = app.files.get('y.md');
		y.content = 'external edit: ![[a.png]]';
		y.stat = { size: y.content.length, mtime: 2 };
		return decode(...args);
	};

	const result = await runImageConversion(app, codec, [{ path: 'a.png', size: 100, mtime: 1 }], { target: 'webp' });

	assert.equal(result.converted.length, 0, 'stat 变化且真读发现旧引用时必须阻止转换');
	assert.equal(result.skipped[0]?.reason, 'residual-reference');
	assert.equal(app.files.has('a.png'), true, '索引滞后但文件变化时也不能误删原图');
	assert.equal(app.files.has('a.webp'), false, '回滚需删除新建图片');
});
