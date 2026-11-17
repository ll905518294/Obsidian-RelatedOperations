import test from 'node:test';
import assert from 'node:assert/strict';
import {
	findRawImageReferenceSources,
	isReferenceSourcePath,
	readReferenceContentSnapshot,
	hasRawImageReference,
} from '../src/image-convert/image-convert-links.ts';

function snapshotApp(notes, { readDelay = 0 } = {}) {
	const readCalls = [];
	return {
		readCalls,
		app: {
			vault: {
				getFiles: () => Object.entries(notes).map(([path, content]) => ({ path, extension: path.split('.').at(-1) })),
				read: async (file) => {
					readCalls.push(file.path);
					if (readDelay) await new Promise((resolve) => setTimeout(resolve, readDelay));
					return notes[file.path];
				},
				cachedRead: async () => { throw new Error('快照必须使用真实读盘 read'); },
			},
		},
	};
}

test('HTML 实体编码的图片引用仍被视为原文引用', () => {
	const content = '&lt;img src="a&amp;#46;png"&gt;';
	assert.equal(hasRawImageReference(content, 'a.png'), true);
});

test('无分号与多层转义的实体编码也能识别', () => {
	assert.equal(hasRawImageReference('a&#46png', 'a.png'), true);
	assert.equal(hasRawImageReference('a&amp;amp;#46;png', 'a.png'), true);
	assert.equal(hasRawImageReference('&lt;img src=&quot;a.png&quot;&gt;', 'a.png'), true);
});

test('带实体编码引用的笔记会被原文兜底拦截', async () => {
	const content = '&lt;img src="a&amp;#46;png"&gt;';
	const app = {
		vault: {
			getFiles: () => [{ path: 'note.md', extension: 'md' }],
			read: async () => content,
		},
	};
	assert.deepEqual(await findRawImageReferenceSources(app, 'a.png'), ['note.md']);
});

test('isReferenceSourcePath 只接受 md/canvas 笔记路径', () => {
	assert.equal(isReferenceSourcePath('note.md'), true);
	assert.equal(isReferenceSourcePath('board.canvas'), true);
	assert.equal(isReferenceSourcePath('pic.png'), false);
	assert.equal(isReferenceSourcePath('note.md/../pic.png'), false);
});

test('readReferenceContentSnapshot 只读一次真实内容，包含所有 sourceKind 并跳过非笔记', async () => {
	const { app, readCalls } = snapshotApp({
		'a.md': '![[img.png]]',
		'b.canvas': '{"nodes":[]}',
		'img.png': 'binary',
		'readme.txt': 'mentions img.png',
	});
	const snapshot = await readReferenceContentSnapshot(app);
	assert.equal(readCalls.length, 2, '只读 md/canvas 两类笔记，各一次');
	assert.deepEqual(readCalls.sort(), ['a.md', 'b.canvas']);
	assert.equal(snapshot instanceof Map, true);
	assert.equal(snapshot.get('a.md'), '![[img.png]]');
	assert.equal(snapshot.get('b.canvas'), '{"nodes":[]}');
	assert.equal(snapshot.has('img.png'), false);
	assert.equal(snapshot.has('readme.txt'), false);
});

test('findRawImageReferenceSources 传 snapshot 时 0 次 read，结果与不传一致', async () => {
	const notes = {
		'one.md': '![[a.png]] and ![](img/a.png)',
		'two.md': 'no references here',
		'board.canvas': '{"nodes":[{"file":"a.png"}]}',
		'three.md': '&lt;img src="a&amp;#46;png"&gt;',
	};
	const { app } = snapshotApp(notes);
	const snapshot = await readReferenceContentSnapshot(app);

	const countingApp = {
		vault: {
			getFiles: app.vault.getFiles,
			read: async (file) => { throw new Error(`快照模式不应读盘：${file.path}`); },
		},
	};
	for (const target of ['a.png', 'img/a.png']) {
		const viaSnapshot = await findRawImageReferenceSources(countingApp, target, false, snapshot);
		assert.ok(Array.isArray(viaSnapshot), `target ${target} 应返回结果`);
	}
});

test('快照模式与非快照模式在同一批笔记上结果一致', async () => {
	const notes = {
		'one.md': '![[a.png]] and ![](img/a.png)',
		'two.md': 'no references here',
		'board.canvas': '{"nodes":[{"file":"a.png"}]}',
		'three.md': '&lt;img src="a&amp;#46;png"&gt;',
	};
	const { app } = snapshotApp(notes);
	const snapshot = await readReferenceContentSnapshot(app);
	for (const target of ['a.png', 'img/a.png', 'missing.png']) {
		const viaDisk = await findRawImageReferenceSources(app, target, false);
		const viaSnapshot = await findRawImageReferenceSources(app, target, false, snapshot);
		assert.deepEqual(viaSnapshot, viaDisk, `target ${target} 的快照结果必须与读盘一致`);
	}
});

test('快照内容被更新后，残留判断随之变化', async () => {
	const notes = { 'note.md': '![[a.png]]' };
	const { app } = snapshotApp(notes);
	const snapshot = await readReferenceContentSnapshot(app);
	assert.deepEqual(await findRawImageReferenceSources(app, 'a.png', false, snapshot), ['note.md']);

	// 模拟 runner 改写后的新内容 set 回快照；磁盘内容不再是依据。
	snapshot.set('note.md', '![](a.webp)');
	assert.deepEqual(await findRawImageReferenceSources(app, 'a.png', false, snapshot), []);
});
