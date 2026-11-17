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
		contents: "export { collectConvertibleImages, estimateConversions } from './src/cleanup/cleanup-scan.ts'; export { normalizeImageConversionConfig } from './src/cleanup/cleanup-types.ts'; export { isCaseSensitiveFileSystem } from './src/core-utils.ts';",
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

const { collectConvertibleImages, estimateConversions, normalizeImageConversionConfig, isCaseSensitiveFileSystem } = await import(
	`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
globalThis.window ??= globalThis;

function file(path, size = 100) {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return { path, name, extension: name.slice(name.lastIndexOf('.') + 1), stat: { size, mtime: 1 } };
}

/*
 * 快速预估不应触碰文件内容：readBinary 一旦被调用就报错，用于证明估算
 * 完全不解码、不重编码。resolvedLinks 是引用数的唯一来源。
 */
function fakeApp({ files = [], existing = new Set(), resolvedLinks = {} } = {}) {
	let getFilesCalls = 0;
	return {
		app: {
			vault: {
				getFiles: () => {
					getFilesCalls += 1;
					return files;
				},
				getAbstractFileByPath: (path) => existing.has(path) ? { path } : null,
				readBinary: async () => {
					throw new Error('估算阶段不应读取文件内容');
				},
				cachedRead: async () => {
					throw new Error('估算阶段不应读取笔记正文');
				},
				read: async () => {
					throw new Error('估算阶段不应读取笔记正文');
				},
			},
			metadataCache: {
				resolvedLinks,
				getFileCache: () => null,
				getFirstLinkpathDest: (link) => (link ? { path: link } : null),
			},
		},
		getFilesCalls: () => getFilesCalls,
	};
}

const config = { sources: ['png'], target: 'jpg', quality: 85, alpha: 'flatten' };

test('快速预估按经验压缩比给出约体积，且不读取/解码文件', async () => {
	const target = file('assets/a.png', 1000);
	const { app, getFilesCalls } = fakeApp({
		files: [target],
		resolvedLinks: { 'note.md': { 'assets/a.png': 1 }, 'other.md': { 'assets/a.png': 1 } },
	});
	const progress = [];
	const items = await estimateConversions(app, [target], config, (value) => progress.push(value));
	assert.deepEqual(items, [{
		path: 'assets/a.png',
		extension: 'png',
		width: 0,
		height: 0,
		oldBytes: 1000,
		// png->jpg 85 质量：1000 × 0.10 × (85/85) = 100
		newBytes: 100,
		hasAlpha: false,
		referenceCount: 2,
		sourceNotePaths: ['note.md', 'other.md'],
	}]);
	assert.equal(progress.at(-1).processed, 1);
	assert.equal(progress.at(-1).total, 1);
	assert.equal(progress.at(-1).currentPath, 'assets/a.png');
	// plan 需要一次 getFiles 快照；引用计数只读内存索引。全程只取一次文件列表。
	assert.equal(getFilesCalls(), 1);
});

test('目标文件已存在时写入 blockedReason 且不预估体积', async () => {
	const files = [file('a.png', 10), file('b.png', 20)];
	// 目标文件必须真实存在于 vault 文件列表，plan 才能判定 target-exists。
	const { app } = fakeApp({ files: [...files, file('b.jpg', 5)] });
	const items = await estimateConversions(app, files, config);
	assert.equal(items.find((item) => item.path === 'b.png').blockedReason, 'target-exists');
	assert.equal(items.find((item) => item.path === 'b.png').newBytes, 0);
});

test('多张图片转到同一目标时按 target-collision 跳过', async () => {
	const files = [file('assets/pic.png', 10), file('assets/pic.webp', 20)];
	const { app } = fakeApp({ files });
	const items = await estimateConversions(app, files, { ...config, sources: ['png', 'webp'] });
	assert.equal(items.length, 2);
	for (const item of items) {
		assert.equal(item.blockedReason, 'target-collision');
		assert.equal(item.newBytes, 0);
	}
});

test('referenceCount 按索引里的引用处数累加，同一篇多次引用计多次', async () => {
	const image = file('assets/a.png', 1000);
	const { app } = fakeApp({
		files: [image],
		resolvedLinks: { 'note.md': { 'assets/a.png': 2 }, 'second.md': { 'assets/a.png': 3 } },
	});
	const [item] = await estimateConversions(app, [image], config);
	assert.equal(item.blockedReason, undefined);
	assert.equal(item.referenceCount, 5);
	assert.deepEqual(item.sourceNotePaths, ['note.md', 'second.md']);
});

test('sourceNotePaths 只去重来源笔记，不把同一篇的多次引用记成多篇', async () => {
	const image = file('assets/a.png', 1000);
	const { app } = fakeApp({
		files: [image],
		resolvedLinks: { 'note.md': { 'assets/a.png': 3 } },
	});
	const [item] = await estimateConversions(app, [image], config);
	assert.equal(item.referenceCount, 3, '同一篇多次引用仍按次数累加');
	assert.deepEqual(item.sourceNotePaths, ['note.md'], '来源笔记路径只保留唯一一篇');
});

test('多篇笔记引用同一图片时 referenceCount 与 sourceNotePaths 都正确', async () => {
	const image = file('assets/a.png', 1000);
	const { app } = fakeApp({
		files: [image],
		resolvedLinks: {
			'notes/甲.md': { 'assets/a.png': 1 },
			'notes/乙.md': { 'assets/a.png': 2 },
			'notes/丙.md': { 'assets/a.png': 1 },
		},
	});
	const [item] = await estimateConversions(app, [image], config);
	assert.equal(item.referenceCount, 4, '次数 = 1 + 2 + 1');
	// 去重后按默认稳定排序（UTF-16 码点）：丙(U+4E19) < 乙(U+4E59) < 甲(U+7532)。
	assert.deepEqual(item.sourceNotePaths, ['notes/丙.md', 'notes/乙.md', 'notes/甲.md'], '路径去重并按原始路径稳定排序');
});

test('没有引用时 referenceCount 为 0 且 sourceNotePaths 为空数组', async () => {
	const image = file('assets/lonely.png', 1000);
	const { app } = fakeApp({ files: [image], resolvedLinks: {} });
	const [item] = await estimateConversions(app, [image], config);
	assert.equal(item.referenceCount, 0);
	assert.deepEqual(item.sourceNotePaths, []);
});

test('引用大小写边界：key 归一化但 sourceNotePaths 保留原始大小写', async () => {
	const image = file('Assets/Pic.PNG', 1000);
	const { app } = fakeApp({
		files: [image],
		resolvedLinks: { 'Note.md': { 'assets/pic.png': 1 } },
	});
	const [item] = await estimateConversions(app, [image], config);
	// key 按 pathKey（平台决定大小写）命中与否都不应崩溃；来源笔记路径必存原始大小写。
	if (isCaseSensitiveFileSystem()) {
		assert.equal(item.referenceCount, 0, '大小写敏感平台不把 pic.png 与 Pic.PNG 等同');
		assert.deepEqual(item.sourceNotePaths, []);
	} else {
		assert.equal(item.referenceCount, 1, '大小写不敏感平台按归一化 key 命中');
		assert.deepEqual(item.sourceNotePaths, ['Note.md']);
	}
});

test('质量越高预估体积越大，目标为 PNG 时质量不参与', async () => {
	const image = file('assets/a.png', 10000);
	const { app } = fakeApp({ files: [image] });
	const at = async (quality) => (await estimateConversions(app, [image], { ...config, quality }))[0].newBytes;
	const lowest = await at(1);
	const low = await at(50);
	const mid = await at(85);
	const high = await at(95);
	const highest = await at(100);
	assert.ok(
		lowest < low && low < mid && mid < high && high < highest,
		`质量应单调影响体积：${lowest} < ${low} < ${mid} < ${high} < ${highest}`,
	);
	assert.ok(lowest * 10 < mid, `quality=1 应明显小于 85：${lowest} vs ${mid}`);

	// PNG 目标下用 JPG 源，避免和 PNG 源同格式被过滤。
	const jpg = file('assets/a.jpg', 10000);
	const { app: pngApp } = fakeApp({ files: [jpg] });
	const pngTarget = async (quality) => (await estimateConversions(pngApp, [jpg], { ...config, sources: ['jpg'], target: 'png', quality }))[0].newBytes;
	assert.equal(await pngTarget(1), await pngTarget(100), 'PNG 为无损目标，质量参数不影响预估');
});

test('不可转换的源格式写入 unsupported-source 且不预估体积', async () => {
	const image = file('assets/a.tiff', 1000);
	const { app } = fakeApp({ files: [image] });
	const [item] = await estimateConversions(app, [image], config);
	assert.equal(item.blockedReason, 'unsupported-source');
	assert.equal(item.newBytes, 0);
});

test('同格式不出现在估算结果里', async () => {
	const image = file('assets/a.png', 100);
	const { app } = fakeApp({ files: [image] });
	const items = await estimateConversions(app, [image], { ...config, target: 'png' });
	assert.deepEqual(items, []);
});

test('中止后停止处理，返回已完成条目', async () => {
	const files = Array.from({ length: 20 }, (_, index) => file(`n/${index}.png`, 10));
	const { app } = fakeApp({ files });
	const controller = new AbortController();
	const items = await estimateConversions(app, files, config, (progress) => {
		if (progress.processed >= 3) controller.abort();
	}, controller.signal);
	assert.ok(items.length >= 3, '已完成的结果必须保留');
	assert.ok(items.length < files.length, '中止后不再处理剩余文件');
});

test('大批量候选在宽松超时内完成，且代码只取一次文件列表', async () => {
	const files = Array.from({ length: 5000 }, (_, index) => file(`bulk/${index}.png`, 100 + index));
	const { app, getFilesCalls } = fakeApp({ files });
	const started = Date.now();
	const items = await estimateConversions(app, files, config);
	const elapsed = Date.now() - started;
	assert.equal(items.length, files.length);
	assert.ok(items.every((item) => item.newBytes > 0));
	assert.equal(getFilesCalls(), 1);
	assert.ok(elapsed < 5000, `5000 张快速预估应在 5 秒内完成，实际 ${elapsed}ms`);
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
	const { app } = fakeApp({ files });
	const result = collectConvertibleImages(app, { ...config, sources: ['png', 'jpg'], target: 'webp' }, 'png, jpg, jpeg, webp', 'ignored');
	assert.deepEqual(result.map((item) => item.path), ['assets/a.png', 'assets/b.JPG']);
});

test('目标格式与源格式相同的文件不在候选集', () => {
	const files = [file('assets/a.png'), file('assets/b.jpg'), file('assets/c.JPEG')];
	const { app } = fakeApp({ files });
	const result = collectConvertibleImages(app, { ...config, sources: ['png', 'jpg'], target: 'jpg' }, 'png, jpg, jpeg');
	assert.deepEqual(result.map((item) => item.path), ['assets/a.png']);
});

test('目标为不同格式时同源文件仍在候选集', () => {
	const files = [file('assets/a.png'), file('assets/b.jpg')];
	const { app } = fakeApp({ files });
	const result = collectConvertibleImages(app, { ...config, sources: ['png', 'jpg'], target: 'webp' }, 'png, jpg');
	assert.deepEqual(result.map((item) => item.path), ['assets/a.png', 'assets/b.jpg']);
});

test('JPEG 扩展名与 JPG 源勾选等价，不会漏掉转换候选', () => {
	const files = [file('assets/a.jpeg'), file('assets/b.JPEG'), file('assets/c.png')];
	const { app } = fakeApp({ files });
	const result = collectConvertibleImages(app, { ...config, sources: ['png', 'jpg'], target: 'webp' }, 'png, jpg, jpeg');
	assert.deepEqual(
		result.map((item) => item.path).sort(),
		['assets/a.jpeg', 'assets/b.JPEG', 'assets/c.png'],
	);
});

test('normalizeImageConversionConfig 收敛旧配置并夹紧质量范围', () => {
	assert.deepEqual(normalizeImageConversionConfig(undefined), config);
	assert.deepEqual(normalizeImageConversionConfig({ sources: ['.PNG', 'jpeg', 'gif'], target: 'webp', quality: 120, alpha: 'skip' }), {
		sources: ['png', 'jpg'],
		target: 'webp',
		quality: 100,
		alpha: 'skip',
	});
	assert.deepEqual(normalizeImageConversionConfig({ sources: 'png', target: 'gif', quality: '90', alpha: 'keep' }), config);
});

test('normalizeImageConversionConfig 丢弃畸形源扩展名并把 jpeg 映射为 jpg', () => {
	assert.deepEqual(normalizeImageConversionConfig({ sources: ['!exe', 'tar.gz', 'JPEG', '.PNG'] }), {
		sources: ['jpg', 'png'],
		target: 'jpg',
		quality: 85,
		alpha: 'flatten',
	});
});
