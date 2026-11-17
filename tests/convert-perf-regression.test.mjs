import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runImageConversion } from '../src/image-convert/image-convert-runner.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 图片转换性能优化（decode 按需 alpha + runner 并发/批量扫描去重）期间的正确性守卫。
 * 本文件刻意使用自包含桩（不安装任何 globalThis/createEl 等浏览器全局），
 * 避免与其它测试文件的全局 stub 交叉污染，保证单跑与全量都稳定。
 *
 * 守卫的不变量：
 *  1. alpha='skip' 时透明图仍被跳过（needAlpha 按需检测不导致漏判）。
 *  2. 部分失败回滚后，其它成功项的引用改写仍有效。
 *  3. 目标文件已存在且内容不同时的处理不变。
 *  4. sourceNotePaths/引用跳转数据不受本轮优化影响。
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

function createApp({ contents = {}, binary = {}, resolvedLinks = {}, caches = {}, createError = false } = {}) {
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
	return {
		files,
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
				files.delete(file.path);
			},
		},
	};
}

function createCodec({ decoded = { width: 10, height: 10, hasAlpha: false }, output = bytesOf(40), encodeError } = {}) {
	const calls = { decode: 0, encode: 0, decodeOptions: [], encodeOptions: [] };
	return {
		calls,
		async decode(bytes, options) {
			calls.decode++;
			calls.decodeOptions.push(options);
			return { ok: true, image: decoded };
		},
		async encode(image, target, options) {
			calls.encode++;
			calls.encodeOptions.push({ target, options: { ...options } });
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

function span(content, original, from = 0) {
	const start = content.indexOf(original, from);
	return { start: { offset: start }, end: { offset: start + original.length } };
}

function wikiCache(content, embeds) {
	return {
		embeds: embeds.map((link) => ({
			link,
			original: `![[${link}]]`,
			position: span(content, `![[${link}]]`),
		})),
		links: [],
	};
}

// ---- 不变量 1：alpha='skip' 仍跳过透明图，且传 needAlpha=true ----
test('不变量1 alpha=skip 且 needAlpha 按需检测不导致透明图漏判', async () => {
	const app = notesApp({ notes: {}, images: { 'img.png': 100 } });
	const codec = createCodec({ decoded: { width: 10, height: 10, hasAlpha: true } });
	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], {
		target: 'webp',
		alpha: 'skip',
	});

	assert.deepEqual(codec.calls.decodeOptions[0], { needAlpha: true }, 'skip 模式应请求按需 alpha 检测');
	assert.deepEqual(
		result.skipped.map((s) => s.reason),
		['alpha-skip'],
		'透明图在 alpha=skip 下必须被跳过',
	);
	assert.equal(codec.calls.encode, 0, '被跳过的透明图不应进入编码');
	assert.equal(result.converted.length, 0);
});

test('不变量1 alpha=flatten 传 needAlpha=false 且透明图被铺白处理', async () => {
	const app = notesApp({ notes: {}, images: { 'img.png': 100 } });
	const codec = createCodec({ decoded: { width: 10, height: 10, hasAlpha: true } });
	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], {
		target: 'webp',
		alpha: 'flatten',
	});

	assert.deepEqual(codec.calls.decodeOptions[0], { needAlpha: false }, 'flatten 模式无需按需 alpha 检测');
	assert.equal(result.converted.length, 1, 'flatten 模式应照常转换');
	assert.equal(result.skipped.length, 0);
});

// ---- 不变量 2：部分失败回滚后，其它成功项的引用改写仍有效 ----
test('不变量2 部分失败回滚后，其它成功项的引用改写仍有效', async () => {
	const note = '![[a.png]]\n![[b.png]]\n![[c.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'a.png': 100, 'b.png': 100, 'c.png': 100 },
		resolvedLinks: {
			'note.md': { 'a.png': 1, 'b.png': 1, 'c.png': 1 },
		},
		caches: {
			'note.md': wikiCache(note, ['a.png', 'b.png', 'c.png']),
		},
	});

	// 让 b.png 的 createBinary 失败（模拟第二次创建失败）。
	let failsForB = false;
	const originalCreate = app.vault.createBinary;
	app.vault.createBinary = async (path, data) => {
		if (path === 'b.webp') {
			failsForB = true;
			throw new Error('模拟 b 创建失败');
		}
		return originalCreate(path, data);
	};

	// 用串行单图转换验证：先把 a 转掉（成功），再让 b 失败，再看 a 的改写仍有效。
	// 直接做一批三图，b 失败时回滚先前的 a 改写——这正是要守卫的语义：
	// 只要某单图在 referenceSites 提前回滚，其余成功项的改写必须保持。
	const codec = createCodec();
	const items = [
		{ path: 'a.png', size: 100, mtime: 1 },
		{ path: 'b.png', size: 100, mtime: 1 },
		{ path: 'c.png', size: 100, mtime: 1 },
	];
	const result = await runImageConversion(app, codec, items, { target: 'webp' });

	// b 转换失败（createBinary 失败），返回 write-failed。
	assert.ok(failsForB, 'b 应进入创建阶段');
	const bFailure = result.failed.find((f) => f.path === 'b.png');
	assert.ok(bFailure, 'b 应失败');
	assert.match(bFailure.reason, /write-failed|create-failed/);

	// a/c 是独立的（不共享 note 引用批处理失败），它们的引用改写要么成功要么不涉及回滚连坐。
	// 守卫点：成功项（a/c）的旧引用已改写，失败项（b）的引用被回滚保留。
	const contentAfter = app.files.get('note.md').content;
	const succeeded = result.converted.map((c) => c.path);
	assert.deepEqual(succeeded.sort(), ['a.png', 'c.png'], 'a/c 应在 b 失败时不受连坐');
	for (const path of ['a.png', 'c.png']) {
		assert.ok(
			!contentAfter.includes(`![[${path}]]`),
			`成功项 ${path} 的旧引用不应残留：${contentAfter}`,
		);
	}
	assert.ok(contentAfter.includes('![[b.png]]'), '失败项 b 的旧引用应保留以允许重试');
});

// ---- 不变量 3：目标文件已存在且内容不同时处理不变 ----
test('不变量3 目标文件已存在且内容不同时跳过并保持引用不变', async () => {
	const note = '![[img.png]]';
	const app = notesApp({
		notes: { 'note.md': note },
		images: { 'img.png': 100, 'img.webp': 200 },
		resolvedLinks: { 'note.md': { 'img.png': 1 } },
		caches: { 'note.md': wikiCache(note, ['img.png']) },
	});
	const codec = createCodec({ output: bytesOf(40) });
	const result = await runImageConversion(app, codec, [{ path: 'img.png', size: 100, mtime: 1 }], {
		target: 'webp',
	});

	assert.deepEqual(
		result.skipped.map((s) => s.reason),
		['target-exists'],
		'目标存在且内容不同应跳过',
	);
	assert.equal(result.converted.length, 0);
	assert.equal(app.files.get('note.md').content, note, '引用应保持不变');
	assert.ok(app.files.has('img.png'), '原图不应被删除');
});

// ---- 不变量 4：sourceNotePaths / 引用跳转数据不受本轮优化影响 ----
// 用源码结构断言替代运行时断言：Estimate 层（ConvertibleImage.sourceNotePaths）与
// runner 层（ConversionItem）分属不同模块，性能优化不应引入耦合或破坏该字段。
const here = dirname(fileURLToPath(import.meta.url));
const typesSource = readFileSync(join(here, '../src/cleanup/cleanup-types.ts'), 'utf8');
const runnerSource = readFileSync(join(here, '../src/image-convert/image-convert-runner.ts'), 'utf8');
const estimateSource = readFileSync(join(here, '../src/cleanup/cleanup-scan.ts'), 'utf8');

test('不变量4 ConvertibleImage.sourceNotePaths 存在且与 runner 解耦', () => {
	// ConvertibleImage 接口仍声明数组形式的 sourceNotePaths（跳转数据来源）。
	assert.match(typesSource, /sourceNotePaths\s*:\s*string\[\]\s*;/, 'ConvertibleImage 应保留 sourceNotePaths 字段');
	// Estimate 层往该字段写入去重后的来源笔记。
	assert.match(estimateSource, /sourceNotePaths:\s*sourcePaths/, '估产层应赋值 sourceNotePaths');
	// Runner 的 ConversionItem 定义中不应出现 sourceNotePaths，防止性能优化把跳转数据耦合进转换阶段。
	assert.doesNotMatch(runnerSource, /\bConversionItem\b[\s\S]{0,400}sourceNotePaths/, 'runner 转换项不应含 sourceNotePaths');
});
