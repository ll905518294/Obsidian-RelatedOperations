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
