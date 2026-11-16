import type { CleanupViewContext, ImageConversionResult } from './cleanup-types';
import { formatBytes } from './cleanup-actions';
import { requireSecondClick } from './cleanup-confirm-button';
import { describeBlockedReason, updateConversionSelectionSummary } from './cleanup-list-convert';

interface ConversionDetail {
	path?: string;
	reason?: string;
	reasonText?: string;
	message?: string;
}

type ConversionWarningEntry = string | {
	path?: string;
	notePath?: string;
	newPath?: string;
	reason?: string;
};

type DetailedConversionResult = ImageConversionResult & {
	unrestored?: ConversionWarningEntry[];
	keptNewFile?: boolean | ConversionWarningEntry[];
	keptNewFilePath?: string;
	pendingTrash?: Array<string | { path?: string; newPath?: string }>;
	aborted?: boolean;
};

function detailText(item: ConversionDetail): string {
	const reason = item.reasonText ?? (item.reason ? describeBlockedReason(item.reason) : item.message);
	if (item.path && reason) return `${item.path}（${reason}）`;
	return item.path ?? reason ?? '未提供明细';
}

function skippedDetails(host: CleanupViewContext, result: DetailedConversionResult): ConversionDetail[] {
	if (result.skippedItems) return result.skippedItems;
	if (!result.skipped) return [];
	return host.conversion.items
		.filter((item) => item.blockedReason)
		.map((item) => ({ path: item.path, reason: item.blockedReason }));
}

function warningPaths(value?: ConversionWarningEntry[]): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => typeof item === 'string' ? item : item.notePath ?? item.path ?? item.newPath ?? item.reason)
		.filter((item): item is string => Boolean(item));
}

function keptNewFilePaths(result: DetailedConversionResult): string[] {
	const paths = Array.isArray(result.keptNewFile) ? warningPaths(result.keptNewFile) : [];
	if (result.keptNewFilePath) paths.push(result.keptNewFilePath);
	if (result.keptNewFile === true && !result.keptNewFilePath && paths.length === 0) paths.push('新文件路径未提供');
	return [...new Set(paths)];
}

function renderResult(host: CleanupViewContext) {
	const result: DetailedConversionResult | undefined = host.conversion.lastResult;
	if (!result) return;
	const skipped = skippedDetails(host, result);
	const failed = result.failedItems ?? [];
	const unrestored = warningPaths(result.unrestored);
	const keptNewFile = keptNewFilePaths(result);
	const summary = host.contentEl.createDiv({ cls: 'orphan-cleanup-result-summary orphan-cleanup-convert-result' });
	summary.setAttribute('role', 'status');
	summary.createEl('strong', { text: '最近一次转换：' });
	summary.createSpan({ text: `成功 ${result.converted} · 跳过 ${result.skipped} · 失败 ${result.failed} · 实际节省 ${formatBytes(result.savedBytes)}` });
	if (result.aborted) {
		summary.createDiv({
			cls: 'orphan-cleanup-convert-aborted mod-warning',
			text: '已中止，已完成的部分保留',
		});
	}
	const pendingTrash = Array.isArray(result.pendingTrash) ? result.pendingTrash : [];
	if (pendingTrash.length) {
		const pending = summary.createDiv({ cls: 'orphan-cleanup-convert-pending-trash mod-warning' });
		pending.createEl('strong', { text: `待重试：${pendingTrash.length} 张（引用已更新，源图仍在）` });
		pending.createDiv({ text: '再次执行同一选择即可只重试移入回收站。' });
	}
	if (unrestored.length) {
		const warning = summary.createDiv({ cls: 'orphan-cleanup-convert-unrestored mod-warning' });
		warning.createEl('strong', { text: '未能回滚的笔记，需人工检查：' });
		warning.createSpan({ text: unrestored.join('、') });
	}
	if (keptNewFile.length) {
		const warning = summary.createDiv({ cls: 'orphan-cleanup-convert-kept-new-file mod-warning' });
		warning.createEl('strong', { text: '为避免断链已保留新文件：' });
		warning.createSpan({ text: keptNewFile.join('、') });
	}
	if (result.failed) {
		summary.createDiv({
			cls: 'orphan-cleanup-convert-failure-text mod-warning',
			text: '原图已保留，部分笔记可能已改为新路径，见下方明细。',
		});
	}
	if (result.skipped === 0 && result.failed === 0) return;

	const collapsible = summary.createEl('details', { cls: 'orphan-cleanup-convert-details' });
	collapsible.createEl('summary', { text: `查看跳过与失败明细（${result.skipped + result.failed}）` });
	if (result.skipped) {
		collapsible.createEl('h4', { text: `跳过（${result.skipped}）` });
		const list = collapsible.createEl('ul');
		if (skipped.length === 0) list.createEl('li', { text: '未提供跳过路径明细。' });
		else for (const item of skipped) list.createEl('li', { text: detailText(item) });
	}
	if (result.failed) {
		collapsible.createEl('h4', { text: `失败（${result.failed}）` });
		const list = collapsible.createEl('ul');
		if (failed.length === 0) list.createEl('li', { text: '未提供失败路径明细。' });
		else for (const item of failed) list.createEl('li', { text: detailText(item) });
	}
}

export function renderConversionActions(host: CleanupViewContext) {
	renderResult(host);

	const actions = host.contentEl.createDiv({ cls: 'orphan-cleanup-actions orphan-cleanup-convert-actions' });
	const summary = actions.createSpan({ cls: 'orphan-cleanup-summary orphan-cleanup-convert-selection-summary' });
	summary.setAttribute('aria-live', 'polite');
	updateConversionSelectionSummary(host, summary);

	const start = actions.createEl('button', { text: '开始转换', cls: 'mod-cta orphan-cleanup-convert-start' });
	if (host.conversion.converting) {
		start.setText('转换中…');
		start.disabled = true;
		const abort = actions.createEl('button', { text: '中止转换', cls: 'orphan-cleanup-convert-abort' });
		abort.addEventListener('click', () => {
			abort.disabled = true;
			abort.setText('正在中止…');
			host.abortConvert?.();
		});
	} else {
		requireSecondClick(start, () => {
			void host.convertSelected();
		}, { confirm: '再次点击开始转换', hint: '再次点击开始转换' });
	}

	updateConversionSelectionSummary(host, summary);
	if (host.conversion.estimating || host.scanningTabs.has(host.activeTab) || host.dirtyTabs.has(host.activeTab)) {
		for (const button of Array.from(actions.querySelectorAll<HTMLButtonElement>('button'))) button.disabled = true;
	}
}
