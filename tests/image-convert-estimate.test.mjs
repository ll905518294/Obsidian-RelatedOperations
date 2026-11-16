import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const stub = `
export class TAbstractFile {}
export class TFile {}
export class TFolder {}
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
		contents: "export { collectConvertibleImages, estimateConversions } from './src/cleanup/cleanup-scan.ts'; export { normalizeImageConversionConfig } from './src/cleanup/cleanup-types.ts';",
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

const { collectConvertibleImages, estimateConversions, normalizeImageConversionConfig } = await import(
	`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

function file(path, size = 100) {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return { path, name, extension: name.slice(name.lastIndexOf('.') + 1), stat: { size } };
}

function fakeApp({
	files = [],
	binaries = {},
	existing = new Set(),
	resolvedLinks = {},
	contents = {},
	caches = {},
	resolve = (link) => (link ? { path: link } : null),
} = {}) {
	return {
		vault: {
			getFiles: () => files,
			getAbstractFileByPath: (path) => existing.has(path) ? { path } : null,
			readBinary: async (target) => binaries[target.path] ?? new ArrayBuffer(8),
			cachedRead: async (target) => contents[target.path] ?? '',
			read: async (target) => contents[target.path] ?? '',
		},
		metadataCache: {
			resolvedLinks,
			getFileCache: (target) => caches[target.path] ?? null,
			getFirstLinkpathDest: (link) => resolve(link),
		},
	};
}

const config = { sources: ['png'], target: 'jpg', quality: 85, alpha: 'flatten' };

test('estimateConversions 给出尺寸、透明度、引用次数与编码后体积', async () => {
	const target = file('assets/a.png', 1000);
	const app = fakeApp({
		files: [target],
		binaries: { 'assets/a.png': new ArrayBuffer(8) },
		resolvedLinks: { 'note.md': { 'assets/a.png': 1 }, 'other.md': { 'assets/a.png': 1 } },
	});
	let decoded = 0;
	const codec = {
		decode: async () => {
			decoded += 1;
			return { ok: true, image: { width: 1200, height: 800, hasAlpha: true, source: {} } };
		},
		encode: async (image, to, options) => {
			assert.deepEqual({ to, options }, { to: 'jpg', options: { quality: 0.85, flatten: true } });
			return { ok: true, bytes: new ArrayBuffer(400) };
		},
	};
	const progress = [];
	const items = await estimateConversions(app, [target], config, codec, (value) => progress.push(value));
	assert.equal(decoded, 1);
	assert.deepEqual(items, [{
		path: 'assets/a.png',
		extension: 'png',
		width: 1200,
		height: 800,
		oldBytes: 1000,
		newBytes: 400,
		hasAlpha: true,
		referenceCount: 0,
	}]);
	assert.equal(progress.at(-1).processed, 1);
	assert.equal(progress.at(-1).total, 1);
	assert.equal(progress.at(-1).currentPath, 'assets/a.png');
});

test('解码失败与目标文件已存在写入 blockedReason，且不再编码', async () => {
	const files = [file('a.png', 10), file('b.png', 20)];
	// 目标文件必须真实存在于 vault 文件列表，plan 才能判定 target-exists。
	const app = fakeApp({ files: [...files, file('b.jpg', 5)] });
	let decodes = 0;
	const codec = {
		decode: async () => {
			decodes += 1;
			throw new Error('corrupt');
		},
		encode: async () => {
			throw new Error('must not encode blocked items');
		},
	};
	const items = await estimateConversions(app, files, config, codec);
	assert.equal(items.find((item) => item.path === 'a.png').blockedReason, '图片解码失败');
	assert.equal(items.find((item) => item.path === 'b.png').blockedReason, 'target-exists');
	assert.equal(decodes, 1, '目标已存在的文件不应读取/解码');
});

test('referenceCount 按引用处数统计，同一篇多次引用计多次', async () => {
	const image = file('assets/a.png', 1000);
	const note = file('note.md', 10);
	const reference = '![[assets/a.png]]';
	const content = `${reference}\n${reference}`;
	const position = (start) => ({
		start: { line: 0, col: start, offset: start },
		end: { line: 0, col: start + reference.length, offset: start + reference.length },
	});
	const app = fakeApp({
		files: [image, note],
		contents: { 'note.md': content },
		caches: {
			'note.md': {
				embeds: [
					{ link: 'assets/a.png', original: reference, position: position(0) },
					{ link: 'assets/a.png', original: reference, position: position(reference.length + 1) },
				],
			},
		},
		resolvedLinks: { 'note.md': { 'assets/a.png': 2 } },
	});
	const codec = {
		decode: async () => ({ ok: true, image: { width: 10, height: 10, hasAlpha: false, source: {} } }),
		encode: async () => ({ ok: true, bytes: new ArrayBuffer(5) }),
	};
	const [item] = await estimateConversions(app, [image], config, codec);
	assert.equal(item.blockedReason, undefined);
	assert.equal(item.referenceCount, 2);
});

test('引用预检把 has-size 等风险直接写进 blockedReason', async () => {
	const image = file('assets/a.png', 1000);
	const note = file('note.md', 10);
	const app = fakeApp({
		files: [image, note],
		contents: { 'note.md': '![[assets/a.png|300]]' },
	});
	const codec = {
		decode: async () => ({ ok: true, image: { width: 10, height: 10, hasAlpha: false, source: {} } }),
		encode: async () => ({ ok: true, bytes: new ArrayBuffer(5) }),
	};
	const [item] = await estimateConversions(app, [image], config, codec);
	assert.equal(item.blockedReason, 'has-size');
	assert.equal(item.newBytes, 0);
});

test('WebP 目标 + alpha=skip 时透明图在估算阶段即标记跳过', async () => {
	const image = file('assets/a.png', 1000);
	const app = fakeApp({ files: [image] });
	let encodes = 0;
	const codec = {
		decode: async () => ({ ok: true, image: { width: 10, height: 10, hasAlpha: true, source: {} } }),
		encode: async () => {
			encodes += 1;
			return { ok: true, bytes: new ArrayBuffer(5) };
		},
	};
	const [item] = await estimateConversions(app, [image], { ...config, target: 'webp', alpha: 'skip' }, codec);
	assert.equal(item.blockedReason, 'alpha-skip');
	assert.equal(item.newBytes, 0);
	assert.equal(encodes, 0);
});

test('JPG + alpha=skip 时透明图仍标记 alpha-skip 且不估算体积', async () => {
	const image = file('assets/a.png', 1000);
	const app = fakeApp({ files: [image] });
	let encodes = 0;
	const codec = {
		decode: async () => ({ ok: true, image: { width: 10, height: 10, hasAlpha: true, source: {} } }),
		encode: async (imageValue, target, options) => {
			encodes += 1;
			return { ok: true, bytes: new ArrayBuffer(5) };
		},
	};
	const [item] = await estimateConversions(app, [image], { ...config, alpha: 'skip' }, codec);
	assert.equal(item.blockedReason, 'alpha-skip');
	assert.equal(item.newBytes, 0);
	assert.equal(encodes, 0);
});

test('JPG + alpha=flatten 时透明图正常估算并按白底体积', async () => {
	const image = file('assets/a.png', 1000);
	const app = fakeApp({ files: [image] });
	const codec = {
		decode: async () => ({ ok: true, image: { width: 10, height: 10, hasAlpha: true, source: {} } }),
		encode: async (imageValue, target, options) => {
			assert.deepEqual({ target, options }, { target: 'jpg', options: { quality: 0.85, flatten: true } });
			return { ok: true, bytes: new ArrayBuffer(5) };
		},
	};
	const [item] = await estimateConversions(app, [image], { ...config, alpha: 'flatten' }, codec);
	assert.equal(item.blockedReason, undefined);
	assert.equal(item.hasAlpha, true);
	assert.equal(item.newBytes, 5);
});

test('单个 Canvas 解析失败只阻塞当前估算，不抛错', async () => {
	const image = file('assets/a.png', 1000);
	const canvas = file('board.canvas', 10);
	const app = fakeApp({ files: [image, canvas], contents: { 'board.canvas': '{not json' } });
	const codec = {
		decode: async () => ({ ok: true, image: { width: 10, height: 10, hasAlpha: false, source: {} } }),
		encode: async () => ({ ok: true, bytes: new ArrayBuffer(5) }),
	};
	const items = await estimateConversions(app, [image], config, codec);
	assert.equal(items.length, 1);
	assert.equal(items[0].blockedReason, 'unsupported-source');
});

test('超过 40MP 的图片不解码后编码', async () => {
	const target = file('huge.png', 50);
	const app = fakeApp({ files: [target] });
	let encodes = 0;
	const codec = {
		decode: async () => ({ ok: true, image: { width: 8000, height: 6000, hasAlpha: false, source: {} } }),
		encode: async () => {
			encodes += 1;
			return { ok: true, bytes: new ArrayBuffer(10) };
		},
	};
	const [item] = await estimateConversions(app, [target], config, codec);
	assert.equal(item.blockedReason, '分辨率超过 40MP');
	assert.equal(item.width, 8000);
	assert.equal(item.newBytes, 0);
	assert.equal(encodes, 0);
});

test('codec 返回的失败原因会写入 blockedReason', async () => {
	const app = fakeApp({ files: [file('x.png', 10), file('y.png', 10)] });
	const decodeFail = {
		decode: async () => ({ ok: false, reason: '无法解码图片：文件损坏' }),
		encode: async () => ({ ok: true, bytes: new ArrayBuffer(1) }),
	};
	const [first] = await estimateConversions(app, [file('x.png', 10)], config, decodeFail);
	assert.equal(first.blockedReason, '无法解码图片：文件损坏');

	const encodeFail = {
		decode: async () => ({ ok: true, image: { width: 10, height: 10, hasAlpha: false, source: {} } }),
		encode: async () => ({ ok: false, reason: '图片编码失败：画布不可用' }),
	};
	const [second] = await estimateConversions(app, [file('y.png', 10)], config, encodeFail);
	assert.equal(second.blockedReason, '图片编码失败：画布不可用');
	assert.equal(second.newBytes, 0);
});

test('中止后返回已完成条目并停止领取新文件', async () => {
	const files = ['a.png', 'b.png', 'c.png', 'd.png'].map((path) => file(path, 10));
	const app = fakeApp({ files });
	const controller = new AbortController();
	let decodes = 0;
	const codec = {
		decode: async () => {
			decodes += 1;
			return { ok: true, image: { width: 10, height: 10, hasAlpha: false, source: {} } };
		},
		encode: async () => ({ ok: true, bytes: new ArrayBuffer(5) }),
	};
	const items = await estimateConversions(app, files, config, codec, (progress) => {
		if (progress.processed >= 2) controller.abort();
	}, controller.signal);
	assert.ok(items.length >= 2, '已完成的结果必须保留');
	assert.ok(items.length < files.length, '中止后不再处理剩余文件');
	assert.ok(decodes <= 3, '最多只多处理并发中的一张');
});

test('collectConvertibleImages 只保留允许的源格式与可见目录', () => {
	const files = [
		file('assets/a.png'),
		file('assets/b.JPG'),
		file('assets/c.gif'),
		file('.obsidian/d.png'),
		file('ignored/e.png'),
		file('assets/f.webp'),
	];
	const app = fakeApp({ files });
	const result = collectConvertibleImages(app, { ...config, sources: ['png', 'jpg'], target: 'webp' }, 'png, jpg, jpeg, webp', 'ignored');
	assert.deepEqual(result.map((item) => item.path), ['assets/a.png', 'assets/b.JPG']);
});

test('目标格式与源格式相同的文件不在候选集', () => {
	const files = [file('assets/a.png'), file('assets/b.jpg'), file('assets/c.JPEG')];
	const app = fakeApp({ files });
	const result = collectConvertibleImages(app, { ...config, sources: ['png', 'jpg'], target: 'jpg' }, 'png, jpg, jpeg');
	assert.deepEqual(result.map((item) => item.path), ['assets/a.png']);
});

test('目标为不同格式时同源文件仍在候选集', () => {
	const files = [file('assets/a.png'), file('assets/b.jpg')];
	const app = fakeApp({ files });
	const result = collectConvertibleImages(app, { ...config, sources: ['png', 'jpg'], target: 'webp' }, 'png, jpg');
	assert.deepEqual(result.map((item) => item.path), ['assets/a.png', 'assets/b.jpg']);
});

test('JPEG 扩展名与 JPG 源勾选等价，不会漏掉转换候选', () => {
	const files = [file('assets/a.jpeg'), file('assets/b.JPEG'), file('assets/c.png')];
	const app = fakeApp({ files });
	const result = collectConvertibleImages(app, { ...config, sources: ['png', 'jpg'], target: 'webp' }, 'png, jpg, jpeg');
	assert.deepEqual(
		result.map((item) => item.path).sort(),
		['assets/a.jpeg', 'assets/b.JPEG', 'assets/c.png'],
	);
});

test('estimateConversions 不返回 same-format 噪声行', async () => {
	const image = file('assets/a.png', 100);
	const app = fakeApp({ files: [image] });
	const codec = {
		decode: async () => ({ ok: true, image: { width: 10, height: 10, hasAlpha: false, source: {} } }),
		encode: async () => ({ ok: true, bytes: new ArrayBuffer(5) }),
	};
	const items = await estimateConversions(app, [image], { ...config, target: 'png' }, codec);
	assert.deepEqual(items, []);
});

test('normalizeImageConversionConfig 收敛旧配置并夹紧质量范围', () => {
	assert.deepEqual(normalizeImageConversionConfig(undefined), config);
	assert.deepEqual(normalizeImageConversionConfig({ sources: ['.PNG', 'jpeg', 'gif'], target: 'webp', quality: 120, alpha: 'skip' }), {
		sources: ['png', 'jpg'],
		target: 'webp',
		quality: 95,
		alpha: 'skip',
	});
	assert.deepEqual(normalizeImageConversionConfig({ sources: 'png', target: 'gif', quality: '90', alpha: 'keep' }), config);
});
