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
		async decode() {
			calls.decode++;
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
