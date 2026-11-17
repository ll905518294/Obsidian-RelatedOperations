import test from 'node:test';
import assert from 'node:assert/strict';
import {
	categoryCount,
	categoryStatus,
	categoryTotal,
	clampPageIndex,
	formatScanDuration,
	pageCount,
	scanPercent,
	tabEntries,
} from '../src/cleanup/cleanup-selectors.ts';

function candidates(overrides = {}) {
	return {
		images: [],
		attachments: [],
		emptyFiles: [],
		folders: [],
		brokenLinks: [],
		nativeLinks: [],
		brokenNoteLinks: [],
		wikiLinks: [],
		duplicates: [],
		duplicateWarnings: [],
		convertibleImages: [],
		...overrides,
	};
}

test('categoryCount 按分类返回候选数量', () => {
	const value = candidates({
		images: [{ path: 'a' }, { path: 'b' }],
		attachments: [{ path: 'c' }],
		brokenLinks: [{ sourcePath: 'd' }],
		nativeLinks: [{ sourcePath: 'e' }, { sourcePath: 'f' }],
		brokenNoteLinks: [{ sourcePath: 'g' }],
		wikiLinks: [{ sourcePath: 'h' }],
		emptyFiles: [{ path: 'h' }],
		folders: [{ path: 'i' }, { path: 'j' }, { path: 'k' }],
		duplicates: [{ hash: 'l' }],
	});
	assert.equal(categoryCount(value, 'images'), 2);
	assert.equal(categoryCount(value, 'attachments'), 1);
	assert.equal(categoryCount(value, 'broken-links'), 1);
	assert.equal(categoryCount(value, 'native-links'), 2);
	assert.equal(categoryCount(value, 'broken-note-links'), 1);
	assert.equal(categoryCount(value, 'wiki-links'), 1);
	assert.equal(categoryCount(value, 'empty-files'), 1);
	assert.equal(categoryCount(value, 'folders'), 3);
	assert.equal(categoryCount(value, 'duplicates'), 1);
	assert.equal(categoryCount(value, 'image-convert'), 0);
	assert.equal(categoryCount(candidates({ convertibleImages: [{ path: 'a.png' }, { path: 'b.png' }] }), 'image-convert'), 2);
});

test('categoryTotal 汇总全部分类', () => {
	assert.equal(categoryTotal(candidates()), 0);
	const value = candidates({ images: [{ path: 'a' }], folders: [{ path: 'b' }, { path: 'c' }], duplicates: [{ hash: 'd' }] });
	assert.equal(categoryTotal(value), 4);
	// 图片压缩不计入体检问题总数。
	assert.equal(categoryTotal(candidates({ convertibleImages: [{ path: 'a.png' }], images: [{ path: 'b.png' }] })), 1);
});

test('categoryStatus 覆盖四种状态文案', () => {
	assert.equal(categoryStatus(0, false, false, false), '尚未扫描');
	assert.equal(categoryStatus(0, true, false, false), '未发现问题');
	assert.equal(categoryStatus(3, true, false, false), '发现 3 项');
	assert.equal(categoryStatus(3, true, false, true), '结果待复核，请重新扫描');
	assert.equal(categoryStatus(0, false, true, false), '正在扫描…');
});

test('scanPercent 扫描时封顶 99，结束后为 100', () => {
	assert.equal(scanPercent(true, 6, { stage: 0, processed: 0, total: 0 }), 0);
	assert.equal(scanPercent(true, 6, { stage: 3, processed: 1, total: 2 }), 58);
	assert.equal(scanPercent(true, 6, { stage: 6, processed: 1, total: 1 }), 99);
	assert.equal(scanPercent(false, 6, { stage: 6, processed: 1, total: 1 }), 100);
	assert.equal(scanPercent(true, 0, { stage: 0, processed: 0, total: 0 }), 0);
});

test('pageCount 与 clampPageIndex 处理边界', () => {
	assert.equal(pageCount(0, 100), 0);
	assert.equal(pageCount(1, 100), 1);
	assert.equal(pageCount(100, 100), 1);
	assert.equal(pageCount(101, 100), 2);

	assert.equal(clampPageIndex(0, 0, 100), 0);
	assert.equal(clampPageIndex(5, 0, 100), 0);
	assert.equal(clampPageIndex(0, 100, 100), 0);
	assert.equal(clampPageIndex(1, 100, 100), 0);
	assert.equal(clampPageIndex(1, 101, 100), 1);
	assert.equal(clampPageIndex(3, 101, 100), 1);
});

test('tabEntries 首页居首，扫描中不重排，非扫描时按有无问题稳定排序', () => {
	const value = candidates({
		images: [{ path: 'a' }, { path: 'b' }],
		brokenLinks: [{ sourcePath: 'c' }],
	});
	const scanning = tabEntries(value, true).map(([tab]) => tab);
	assert.deepEqual(scanning, [
		'overview', 'images', 'attachments', 'broken-links', 'native-links',
		'broken-note-links', 'wiki-links', 'empty-files', 'folders', 'duplicates', 'image-convert',
	]);

	const sorted = tabEntries(value, false);
	assert.deepEqual(sorted.map(([tab]) => tab), [
		'overview', 'images', 'broken-links', 'attachments', 'native-links',
		'broken-note-links', 'wiki-links', 'empty-files', 'folders', 'duplicates', 'image-convert',
	]);
	assert.equal(sorted[0][1], '体检首页');
	assert.equal(sorted[0][2], 3);
	assert.deepEqual(sorted.at(-1), ['image-convert', '图片压缩', 0]);
});

test('图片压缩标签固定在末位，不参与分类排序', () => {
	const value = candidates({ convertibleImages: [{ path: 'a.png' }, { path: 'b.png' }], images: [{ path: 'c.png' }] });
	const entries = tabEntries(value, false);
	assert.deepEqual(entries.at(-1), ['image-convert', '图片压缩', 2]);
	assert.equal(entries[1][0], 'images', '分类仍按有无问题排序，转换标签不插队');
	assert.equal(entries.length, 11);
});

test('formatScanDuration 处理秒、分与负数', () => {
	assert.equal(formatScanDuration(0), '0 秒');
	assert.equal(formatScanDuration(59999), '59 秒');
	assert.equal(formatScanDuration(60000), '1 分 0 秒');
	assert.equal(formatScanDuration(125000), '2 分 5 秒');
	assert.equal(formatScanDuration(-100), '0 秒');
});
