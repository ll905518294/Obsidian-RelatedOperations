import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRawImageReference } from '../src/image-convert/image-convert-links.ts';

/**
 * 安全守卫：图片转换「一次内容快照 + 快照查残留引用」高风险改动的护栏。
 *
 * 背景：01/03 计划把「每张图全库读笔记」优化为「一次内容快照 + 用快照查残留引用」。
 * 若快照陈旧或未包含某篇新增引用的笔记，转换后会把仍被引用的原图移入回收站（数据损失）。
 *
 * 本文件用真实解析元语 hasRawImageReference（纯函数）实现可注入快照的残留查询，
 * 逐条验证 5 个核心风险场景。它不依赖任何全局 stub，单跑与全量均稳定。
 *
 * 注意：快照改动尚未落盘（git 干净），当前 runner 的残留检查仍是「每次真读盘」。
 * 下列场景 1-3、5 表达「快照实现必须满足的契约」；场景 4 是漏判红线演示——它不针对当前
 * 真读盘实现（当前不漏判），而是证明「快照陈旧/未含新增 → 必然漏判」，必须由 01/03 堵住。
 */

const encoder = new TextEncoder();

/** 只读的最小笔记快照：path → content。 */
function snapshotFromFiles(files) {
	const map = new Map();
	for (const f of files) map.set(f.path, f.content);
	return map;
}

/** 模拟「快照查询残留引用」：遍历快照内容，用真实解析元语判定是否含旧路径引用。 */
function queryResidualSources(snapshot, target, caseSensitive = false) {
	const sources = [];
	for (const [path, content] of snapshot) {
		if (hasRawImageReference(content, target, caseSensitive)) sources.push(path);
	}
	return [...sources].sort();
}

function mdFile(path, content) {
	return { path, extension: 'md', content, stat: { size: content.length, mtime: 1 } };
}

function binaryFile(path, bytes) {
	return {
		path,
		extension: path.split('.').at(-1),
		content: '',
		stat: { size: bytes.length, mtime: 1 },
		binary: encoder.encode(bytes).buffer,
	};
}

// 场景 1：快照查询 vs 真读盘结果一致 -------------------------------
// 把「真读盘」模拟为直接读每个文件的最新 content；快照在同一时刻取的就是这些 content，
// 因此二者必须一致——这是快照的第一条安全不变量。
test('场景1 快照查询与真读盘在相同时刻结果一致', () => {
	const files = [
		mdFile('x.md', '正文 ![[a.png]] 和后文'),
		mdFile('y.md', '没有图片'),
		mdFile('z.md', '另一个 ![[a.png]] 引用'),
	];
	const snapshot = snapshotFromFiles(files);

	const fromSnapshot = queryResidualSources(snapshot, 'a.png', false);
	const fromDisk = files
		.filter((f) => hasRawImageReference(f.content, 'a.png', false))
		.map((f) => f.path)
		.sort();

	assert.deepEqual(fromSnapshot, fromDisk, '快照查询必须与真读盘逐字一致');
	assert.deepEqual(fromSnapshot, ['x.md', 'z.md']);
});

// 场景 2：改写后残留消失 -------------------------------------------
// 图片 A 被 X 引用 → 把 X 的内容改写成指向新路径、并更新快照 → 残留检查必须为空。
test('场景2 改写并更新快照后残留检查返回空', () => {
	const x = mdFile('x.md', '正文 ![[a.png]] 引用');
	const snapshot = snapshotFromFiles([x]);
	assert.deepEqual(queryResidualSources(snapshot, 'a.png', false), ['x.md'], '改写前能查到残留');

	x.content = x.content.replace('![[a.png]]', '![[a.webp]]'); // 改写 X 指向新路径
	snapshot.set(x.path, x.content); // 更新快照

	assert.deepEqual(queryResidualSources(snapshot, 'a.png', false), [], '改写并同步快照后残留必须消失');
	assert.deepEqual(queryResidualSources(snapshot, 'a.webp', false), ['x.md'], '新路径作为新的残留目标');
});

// 场景 3：改写失败回滚 ----------------------------------------------
// 改写 X 后又回滚为原文并同步快照 → 残留检查必须重新看到旧引用。
test('场景3 改写失败回滚后残留检查重新看到旧引用', () => {
	const x = mdFile('x.md', '![[a.png]]');
	const snapshot = snapshotFromFiles([x]);

	x.content = x.content.replace('![[a.png]]', '![[a.webp]]'); // 假改写
	snapshot.set(x.path, x.content);
	assert.deepEqual(queryResidualSources(snapshot, 'a.png', false), [], '改写后旧引用消失');

	x.content = '![[a.png]]'; // 回滚为原文
	snapshot.set(x.path, x.content); // 同步回滚后的快照
	assert.deepEqual(queryResidualSources(snapshot, 'a.png', false), ['x.md'], '回滚后残留检查必须再次看到旧引用');
});

// 场景 4（漏判红线）：快照未含新增引用的笔记时必然漏判 ----------------
// 这是最重要的守卫。当前 runner 每次真读盘，不会漏判；但一旦改成快照查询，
// 若笔记 Y 在快照生成后才新增对旧路径的引用（或快照本身漏掉 Y），残留检查就会漏判，
// 从而把仍被 Y 引用的原图移入回收站 → 数据损失。
test('场景4漏判红线 快照未含笔记Y时残留检查漏掉Y（必须堵住的洞）', () => {
	// 快照生成瞬间只有 X 引用 a.png。
	const x = mdFile('x.md', '![[a.png]]');
	const snapshot = snapshotFromFiles([x]);

	// 转换期间：原本不引用 a.png 的 Y 外部新增了对旧路径的引用（快照此时仍未包含 Y）。
	const y = mdFile('y.md', '看这张参考图：![[a.png]]');

	const fromSnapshot = queryResidualSources(snapshot, 'a.png', false);
	const fromDisk = queryResidualSources(snapshotFromFiles([x, y]), 'a.png', false);

	assert.ok(!fromSnapshot.includes('y.md'), '前提：快照未包含 Y');
	assert.deepEqual(fromDisk, ['x.md', 'y.md'], '真读盘能看到 Y 的残留引用');
	assert.ok(
		fromSnapshot.length < fromDisk.length,
		`漏判红线：快照查询(${fromSnapshot.length}) 少于真读盘(${fromDisk.length})，Y 的引用被漏掉`,
	);
	assert.ok(
		hasRawImageReference(y.content, 'a.png', false),
		'漏判红线证据：Y 的真实内容仍含旧路径，若残留检查只看陈旧快照会把 a.png 误删',
	);
});

// 场景 5：8 图共写一篇笔记，串行锁 + 快照更新后所有残留检查都正确 -------
// 模拟 8 张图先后改写同一篇笔记的场景：每次改写都立即同步快照，
// 任意时刻对任何旧路径的残留检查都只返回「仍未改写的那几张」。
test('场景5 8图共写一篇笔记时快照顺序更新保证残留检查一致', () => {
	const pngs = Array.from({ length: 8 }, (_, i) => `img${i}.png`);
	let note = pngs.map((p) => `![[${p}]]`).join('\n');
	const noteFile = mdFile('note.md', note);
	const snapshot = snapshotFromFiles([noteFile]);

	const converted = [];
	for (let i = 0; i < pngs.length; i += 1) {
		const oldPath = pngs[i];
		// 串行改写第 i 张图，并把 note.md 内容同步进快照。
		note = note.replace(`![[${oldPath}]]`, `![[${oldPath.replace('.png', '.webp')}]]`);
		noteFile.content = note;
		snapshot.set(noteFile.path, note);
		converted.push(oldPath);

		// 已改写图的旧路径必须已从残留检查消失。
		const still = queryResidualSources(snapshot, oldPath, false);
		assert.deepEqual(still, [], `第 ${i} 张图改写后残留检查应为空，实际 ${JSON.stringify(still)}`);
	}

	// 全部改写后，旧路径一律无残留，新路径全部可见。
	for (const p of pngs) {
		assert.deepEqual(queryResidualSources(snapshot, p, false), [], `旧路径 ${p} 不应有残留`);
		assert.deepEqual(queryResidualSources(snapshot, p.replace('.png', '.webp'), false), ['note.md']);
	}
});
