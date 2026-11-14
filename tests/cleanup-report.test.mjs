import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCleanupReport } from '../src/cleanup-report.ts';

test('builds a markdown report with escaped table content and processing summary', () => {
	const report = buildCleanupReport({
		generatedAt: '2026-08-29 12:00', images: ['a|b.png'], folders: ['empty'],
		brokenLinks: [{ sourcePath: 'note.md', original: '![](x.png)', linkPath: 'x.png' }],
		nativeLinks: [{ sourcePath: 'note.md', original: '![[a.png]]', status: '可转换' }],
		processed: { success: 1, skipped: 2, failed: [{ path: 'bad.md', reason: '拒绝访问' }] },
	});
	assert.match(report, /a\\|b\.png/);
	assert.match(report, /本批次处理摘要/);
	assert.match(report, /拒绝访问/);
});

test('collapses newlines inside table cells so rows stay intact', () => {
	const report = buildCleanupReport({
		generatedAt: 't', images: [], folders: [], brokenLinks: [], nativeLinks: [],
		duplicates: [], duplicateWarnings: [],
		processed: { success: 1, skipped: 0, failed: [{ path: 'note.md', reason: '包含\n表格|分隔符' }] },
	});
	const brokenRow = report.split('\n').find((line) => line.startsWith('| 失败原因 |'));
	assert.ok(brokenRow, '失败原因行必须存在且未被打断成多行');
	assert.ok(!brokenRow.includes('\n'));
	assert.ok(!brokenRow.includes('\r'));
	assert.ok(brokenRow.includes('表格\\|分隔符'));
});

test('escapes backticks and keeps optional sections when counts are zero', () => {
	const report = buildCleanupReport({
		generatedAt: 't', images: [], folders: [], brokenLinks: [], nativeLinks: [],
		duplicates: [], duplicateWarnings: [],
		processed: { success: 0, skipped: 0, failed: [{ path: 'a`b.md', reason: 'x' }] },
	});
	const failedRow = report.split('\n').find((line) => line.startsWith('| 失败原因 |'));
	assert.ok(failedRow.includes('a\\`b.md'));
	assert.match(report, /未引用附件：0/);
	assert.match(report, /空文件：0/);
	assert.match(report, /失效笔记链接：0/);
	assert.match(report, /重复文件组：0/);
});

test('escapes table and inline markdown metacharacters in paths without breaking rows', () => {
	const path = 'a|b`c<d>[e]@f#g.png';
	const report = buildCleanupReport({
		generatedAt: 't', images: [path], folders: [], brokenLinks: [], nativeLinks: [],
		duplicates: [], duplicateWarnings: [],
	});
	const row = report.split('\n').find((line) => line.includes('a\\|b'));
	assert.ok(row, '包含特殊字符的图片行必须存在');
	assert.ok(!row.includes('\n') && !row.includes('\r'));
	assert.ok(row.includes('a\\|b\\`c\\<d\\>\\[e\\]@f#g.png'), `got ${row}`);
	assert.ok(!/(?<!\\)\[e\]/.test(row), '未转义的方括号可能被渲染成链接');
});
