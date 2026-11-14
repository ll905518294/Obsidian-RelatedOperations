import type { DuplicateFileGroup } from './duplicate-files.ts';
import { cleanupRiskLabel, riskForCleanupTab } from './cleanup-risk.ts';

export interface CleanupReportData {
	generatedAt: string; images: string[]; attachments?: string[]; emptyFiles?: string[]; folders: string[];
	brokenLinks: Array<{ sourcePath: string; original: string; linkPath: string }>;
	nativeLinks: Array<{ sourcePath: string; original: string; status: string }>;
	brokenNoteLinks?: Array<{ sourcePath: string; original: string; linkPath: string; syntax: string }>;
	duplicates?: DuplicateFileGroup[];
	duplicateWarnings?: Array<{ path: string; reason: string }>;
	processed?: { success: number; skipped: number; failed: Array<{ path: string; reason: string }> };
}
const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ').replaceAll('`', '\\`');
export function buildCleanupReport(data: CleanupReportData): string {
	const lines = [`# Vault 体检报告`, ``, `生成时间：${data.generatedAt}`, ``, `## 摘要`, ``, `- 未引用图片：${data.images.length}（${cleanupRiskLabel(riskForCleanupTab('images'))}）`, `- 未引用附件：${data.attachments?.length ?? 0}（${cleanupRiskLabel(riskForCleanupTab('attachments'))}）`, `- 空文件：${data.emptyFiles?.length ?? 0}（${cleanupRiskLabel(riskForCleanupTab('empty-files'))}）`, `- 空文件夹：${data.folders.length}（${cleanupRiskLabel(riskForCleanupTab('folders'))}）`, `- 失效图片链接：${data.brokenLinks.length}（${cleanupRiskLabel(riskForCleanupTab('broken-links'))}）`, `- 原生图片链接：${data.nativeLinks.length}（${cleanupRiskLabel(riskForCleanupTab('native-links'))}）`, `- 失效笔记链接：${data.brokenNoteLinks?.length ?? 0}（${cleanupRiskLabel(riskForCleanupTab('broken-note-links'))}）`, `- 重复文件组：${data.duplicates?.length ?? 0}（${cleanupRiskLabel(riskForCleanupTab('duplicates'))}）`, `- 重复文件：${data.duplicates?.reduce((sum, group) => sum + group.files.length, 0) ?? 0}`, `- 重复扫描警告：${data.duplicateWarnings?.length ?? 0}`];
	const section = (title: string, headers: string[], rows: string[][]) => { lines.push('', `## ${title}`, '', `| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)); };
	section('未引用图片', ['路径'], data.images.map((path) => [path]));
	section('未引用附件', ['路径'], (data.attachments ?? []).map((path) => [path]));
	section('空文件', ['路径'], (data.emptyFiles ?? []).map((path) => [path]));
	section('空文件夹', ['路径'], data.folders.map((path) => [path]));
	section('失效图片链接', ['源笔记', '原始链接', '目标'], data.brokenLinks.map((item) => [item.sourcePath, item.original, item.linkPath]));
	section('原生图片链接', ['源笔记', '原始链接', '状态'], data.nativeLinks.map((item) => [item.sourcePath, item.original, item.status]));
	section('失效笔记链接', ['源笔记', '原始链接', '目标', '类型'], (data.brokenNoteLinks ?? []).map((item) => [item.sourcePath, item.original, item.linkPath, item.syntax]));
	section('重复文件', ['哈希', '大小', '文件路径', '引用状态'], (data.duplicates ?? []).flatMap((group) => group.files.map((file) => [group.hash, String(group.size), file.path, file.referenced ? '已被引用' : '未发现引用'])));
	section('重复扫描警告', ['路径', '原因'], (data.duplicateWarnings ?? []).map((item) => [item.path, item.reason]));
	if (data.processed) section('本批次处理摘要', ['项目', '数量/详情'], [['成功', String(data.processed.success)], ['跳过', String(data.processed.skipped)], ['失败', String(data.processed.failed.length)], ...data.processed.failed.map((item) => ['失败原因', `${item.path}（${item.reason}）`])]);
	return `${lines.join('\n')}\n`;
}
