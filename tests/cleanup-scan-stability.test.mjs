import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const stub = `
export class TAbstractFile {}
export class TFile extends TAbstractFile { constructor(path) { super(); this.path = path; } }
export class TFolder extends TAbstractFile {}
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
		contents: "export { findCleanupCandidates } from './src/cleanup/cleanup-scan.ts';",
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

const { findCleanupCandidates } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function makeFile(path, content = '') {
	return {
		path,
		name: path.split('/').at(-1),
		extension: path.split('.').at(-1).toLowerCase(),
		stat: { size: content.length, mtime: 1 },
		__content: content,
	};
}

/*
 * 可变的资料库桩：getAbstractFileByPath 与 getFiles 都读取同一个 Map，
 * 测试可以在扫描进行中删除、改名或新建文件，模拟 Obsidian 的真实事件。
 */
function createVault(initial, options = {}) {
	const files = new Map(initial.map((file) => [file.path, file]));
	const missing = (file) => files.get(file.path) !== file;
	const read = async (file) => {
		if (missing(file)) throw new Error(`文件已不存在：${file.path}`);
		if (options.readError?.(file)) throw new Error('读取失败');
		return file.__content;
	};
	const app = {
		vault: {
			getFiles: () => [...files.values()],
			getMarkdownFiles: () => [...files.values()].filter((file) => file.extension === 'md'),
			getAbstractFileByPath: (path) => files.get(path) ?? null,
			getRoot: () => ({ path: '', children: [] }),
			cachedRead: read,
			read,
			readBinary: async (file) => {
				if (missing(file)) throw new Error(`文件已不存在：${file.path}`);
				return new TextEncoder().encode(file.__content).buffer;
			},
		},
		metadataCache: {
			resolvedLinks: options.resolvedLinks ?? {},
			getFileCache: (file) => options.cacheFor?.(file) ?? null,
			getFirstLinkpathDest: (link, sourcePath) => options.resolve?.(link, sourcePath) ?? null,
		},
	};
	return { app, files };
}

function renameFile(files, file, newPath) {
	files.delete(file.path);
	file.path = newPath;
	file.name = newPath.split('/').at(-1);
	files.set(newPath, file);
}

test('扫描期间被删除的图片不会出现在分类结果或最终候选里', async () => {
	const image = makeFile('assets/gone.png', 'image-bytes');
	const note = makeFile('note.md', 'plain text');
	const { app, files } = createVault([image, note]);
	const published = [];
	const result = await findCleanupCandidates(app, 'png', '', (progress) => {
		if (progress.stage === 2 && progress.processed >= 1) files.delete(image.path);
	}, true, (tabs, results) => published.push({ tabs, results }));
	const imageUpdate = published.find((entry) => entry.tabs.includes('images'));
	assert.ok(imageUpdate, '图片分类必须发布一次');
	assert.deepEqual(imageUpdate.results.images, []);
	assert.deepEqual(imageUpdate.results.attachments, []);
	assert.deepEqual(result.images, []);
	assert.deepEqual(result.attachments, []);
});

test('扫描期间被删除的空文件既不会成为候选也不会让扫描失败', async () => {
	const empty = makeFile('empty.md', '');
	const note = makeFile('note.md', '# title');
	const { app, files } = createVault([empty, note]);
	const result = await findCleanupCandidates(app, 'png', '', (progress) => {
		if (progress.stage === 3 && progress.currentFile === 'empty.md') files.delete(empty.path);
	});
	assert.deepEqual(result.emptyFiles, []);
});

test('单个笔记读取失败只跳过该笔记，不影响引用判断和空文件扫描', async () => {
	const photo = makeFile('assets/photo.png', 'image-bytes');
	// 读取失败的笔记可能引用任意图片，不能被当成空文件，也不能让扫描失败。
	const broken = makeFile('broken.md', 'unreadable body');
	const empty = makeFile('empty.md', '');
	const { app } = createVault([photo, broken, empty], {
		readError: (file) => file.path === 'broken.md',
	});
	const result = await findCleanupCandidates(app, 'png');
	assert.deepEqual(result.images, [], '读不到的笔记存在时，图片不得成为未引用候选');
	assert.deepEqual(result.emptyFiles.map((file) => file.path), ['empty.md']);
});

test('扫描期间改名的重复文件不会留下旧路径', async () => {
	const first = makeFile('dup/a.bin', 'same-bytes');
	const second = makeFile('dup/b.bin', 'same-bytes');
	const { app, files } = createVault([first, second]);
	const result = await findCleanupCandidates(app, 'png', '', (progress) => {
		if (progress.stage === 3 && progress.processed >= 1) renameFile(files, first, 'dup/a-renamed.bin');
	}, true);
	const paths = result.duplicates.flatMap((group) => group.files.map((file) => file.path));
	assert.ok(!paths.includes('dup/a.bin'), `旧路径仍残留：${paths.join(', ')}`);
	assert.deepEqual(paths.sort(), ['dup/a-renamed.bin', 'dup/b.bin']);
});

test('链接阶段之后新建目标或删除源笔记时，失效链接候选不会残留', async () => {
	const linker = makeFile('linker.md', 'see [[missing]]');
	const doomed = makeFile('doomed.md', 'see [[never]]');
	const cacheFor = (file) => {
		if (file.path === 'linker.md') {
			return { links: [{ original: '[[missing]]', link: 'missing', position: { start: { offset: 4 }, end: { offset: 15 } } }] };
		}
		if (file.path === 'doomed.md') {
			return { links: [{ original: '[[never]]', link: 'never', position: { start: { offset: 4 }, end: { offset: 13 } } }] };
		}
		return null;
	};
	let missing = null;
	const { app, files } = createVault([linker, doomed], {
		cacheFor,
		resolve: (link) => (link === 'missing' ? missing : null),
	});
	const result = await findCleanupCandidates(app, 'png', '', undefined, true, (tabs) => {
		if (!tabs.includes('broken-note-links')) return;
		missing = makeFile('missing.md', 'now exists');
		files.set(missing.path, missing);
		files.delete(doomed.path);
	});
	assert.deepEqual(result.brokenNoteLinks, []);
});

test('重复文件结果发布后被删除的文件会在返回前剔除', async () => {
	const first = makeFile('dup/a.bin', 'same-bytes');
	const second = makeFile('dup/b.bin', 'same-bytes');
	const { app, files } = createVault([first, second]);
	const result = await findCleanupCandidates(app, 'png', '', undefined, true, (tabs) => {
		if (!tabs.includes('duplicates')) return;
		files.delete(second.path);
	});
	assert.deepEqual(result.duplicates, []);
});

test('扫描期间新建的文件不会崩溃，也不会被当成已扫描的候选项', async () => {
	const note = makeFile('note.md', '# title');
	const { app, files } = createVault([note]);
	const result = await findCleanupCandidates(app, 'png', '', (progress) => {
		if (progress.stage === 3 && !files.has('new.md')) files.set('new.md', makeFile('new.md', ''));
	});
	assert.deepEqual(result.emptyFiles, []);
});
