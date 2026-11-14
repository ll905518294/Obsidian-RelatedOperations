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
