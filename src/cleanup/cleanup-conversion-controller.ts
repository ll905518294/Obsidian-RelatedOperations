import { Notice } from 'obsidian';
import type { ImageCodec } from '../image-convert/image-codec';
import { runImageConversion, type ConversionApp, type ConversionResult } from '../image-convert/image-convert-runner';
import { collectConvertibleImages, estimateConversions as estimateConversionCosts } from './cleanup-scan';
import { clearConversionSelections } from './cleanup-list-convert';
import { formatBytes, reasonFor } from './cleanup-actions';
import {
	cloneImageConversionConfig,
	normalizeImageConversionConfig,
	type CleanupViewContext,
	type ImageConversionConfig,
	type ImageConversionResult,
	type ImageConversionState,
	type OrphanCleanupOptions,
	type ReadonlyImageConversionConfig,
} from './cleanup-types';

// 转换仍按单文件批次推进：多张图被同一篇笔记引用时，两个 worker 同时
// 改写会互相覆盖，回滚还可能丢掉对方已完成的结果。并发提升只作用于
// 估算与 runner 内部的解码/编码，不改变这里的串行提交边界。
const CONVERSION_BATCH_SIZE = 1;

type ConversionProgressPhase = 'estimate' | 'convert';

/*
 * 进度反馈只改进度文本与填充条，不重建整页。图片转换页在 5000+ 候选时
 * 每次 renderContents 都要重建整张列表；估算/转换期间每 150/200ms 整页
 * 重建是 Obsidian 卡顿的主因。进度节点尚未渲染时才允许回退整页一次。
 */
function paintProgress(panel: CleanupConversionHost, phase: ConversionProgressPhase, fallback: { used: boolean }): void {
	const root: ParentNode | undefined = panel.contentEl;
	const wrapper = root?.querySelector<HTMLElement>('.orphan-cleanup-convert-progress');
	const text = root?.querySelector<HTMLElement>('.orphan-cleanup-convert-progress-text');
	if (!wrapper || !text) {
		if (!fallback.used) {
			fallback.used = true;
			panel.renderContents();
		}
		return;
	}
	const progress = phase === 'convert' ? panel.conversion.convertProgress : panel.conversion.estimateProgress;
	const verb = phase === 'convert' ? '转换' : '估算';
	wrapper.setAttribute('data-phase', phase);
	if (progress.total > 0) {
		const path = progress.currentPath ? ` · ${progress.currentPath}` : '';
		text.setText(`正在${verb} ${progress.processed} / ${progress.total}${path}`);
		const fill = root?.querySelector<HTMLElement>('.orphan-cleanup-convert-progress-fill');
		if (fill) {
			const percent = Math.min(100, Math.max(0, progress.processed / progress.total * 100));
			fill.style.width = `${percent}%`;
		}
	} else {
		text.setText(`正在${verb}…`);
	}
}

export function createConversionState(config: ReadonlyImageConversionConfig): ImageConversionState {
	const copy = cloneImageConversionConfig(config);
	return {
		...copy,
		config: cloneImageConversionConfig(copy),
		items: [],
		estimating: false,
		converting: false,
		estimateProgress: { processed: 0, total: 0 },
		convertProgress: { processed: 0, total: 0 },
	};
}

/**
 * Image conversion flows for OrphanCleanupPanel: estimate, convert and config
 * updates. The panel keeps its conversion state; this module owns the flows.
 */
export interface CleanupConversionHost extends CleanupViewContext {
	options: OrphanCleanupOptions;
	disposed?: boolean;
	estimateController?: AbortController;
	convertController?: AbortController;
	conversionSaveTimer: number;
	conversionConfig(): ImageConversionConfig;
	imageCodec(): ImageCodec;
}

export async function estimateConversions(panel: CleanupConversionHost): Promise<void> {
	clearConversionSelections(panel);
	if (panel.conversion.estimating) return;
	if (panel.disposed) return;
	const files = panel.candidates.convertibleImages;
	if (files.length === 0) { new Notice('没有符合条件的图片；请先扫描候选。'); return; }
	const controller = new AbortController();
	panel.estimateController = controller;
	panel.conversion.estimating = true;
	panel.conversion.estimateProgress = { processed: 0, total: files.length };
	panel.renderContents();
	let lastPaint = 0;
	const paintFallback = { used: false };
	try {
		const items = await estimateConversionCosts(panel.app, files, panel.conversionConfig(), (progress) => {
			panel.conversion.estimateProgress = progress;
			const now = performance.now();
			// 大批量图片时避免每个进度都重建整页 DOM；只就地更新进度条。
			if (panel.activeTab !== 'image-convert' || (now - lastPaint < 150 && progress.processed < progress.total)) return;
			lastPaint = now;
			paintProgress(panel, 'estimate', paintFallback);
		}, controller.signal);
		if (panel.disposed) return;
		// 中止时扫描只返回已处理的部分；不能用它覆盖上一次的完整估算结果。
		if (controller.signal.aborted) {
			new Notice('已中止估算：保留上一次结果。');
			return;
		}
		panel.conversion.items = items;
	} catch (error) {
		if (panel.disposed) return;
		if (controller.signal.aborted) new Notice('已中止估算：保留上一次结果。');
		else new Notice(`估算失败：${reasonFor(error)}`);
	} finally {
		panel.conversion.estimating = false;
		if (panel.estimateController === controller) panel.estimateController = undefined;
		if (!panel.disposed) panel.renderContents();
	}
}

export function abortEstimate(panel: CleanupConversionHost): void {
	panel.estimateController?.abort();
}

export function abortConvert(panel: CleanupConversionHost): void {
	panel.convertController?.abort();
}

export async function convertSelected(panel: CleanupConversionHost): Promise<void> {
	if (panel.disposed) return;
	const selected = panel.candidates.convertibleImages.filter((file) => panel.convertSelections.has(file.path));
	if (selected.length === 0) { new Notice('请先选择要转换的图片。'); return; }
	const blocked = new Set(panel.conversion.items.filter((item) => item.blockedReason).map((item) => item.path));
	const files = selected.filter((file) => !blocked.has(file.path));
	if (files.length === 0) { new Notice('所选图片均已被标记为不可转换；请重新估算或取消选择。'); return; }
	if (panel.conversion.estimating || panel.conversion.converting) { new Notice('估算或转换正在进行，请稍后再试。'); return; }
	const controller = new AbortController();
	panel.convertController = controller;
	panel.conversion.converting = true;
	panel.conversion.convertProgress = { processed: 0, total: files.length };
	panel.renderContents();
	let convertPaint = 0;
	const paintFallback = { used: false };
	try {
		const config = panel.conversionConfig();
		const result: ConversionResult = { converted: [], skipped: [], failed: [], pendingTrash: [], savedBytes: 0, aborted: false, unrestored: [] };
		for (let index = 0; index < files.length; index += CONVERSION_BATCH_SIZE) {
			if (panel.disposed || controller.signal.aborted) { result.aborted = true; break; }
			const batch = files.slice(index, index + CONVERSION_BATCH_SIZE);
			panel.conversion.convertProgress = { processed: index, total: files.length, currentPath: batch[0]?.path };
			// 大批量时避免每张都重建整页 DOM；进度条就地推进。
			const now = performance.now();
			if (now - convertPaint >= 200) {
				convertPaint = now;
				paintProgress(panel, 'convert', paintFallback);
			}
			const partial = await runImageConversion(
				// Obsidian 的 App 在运行期满足 runner 需要的子集；vault.delete 的参数
				// 逆变让 TS 拒绝直接赋值，因此这里显式收窄。
				panel.app as unknown as ConversionApp,
				panel.imageCodec(),
				batch.map((file) => ({ path: file.path, size: file.stat.size, mtime: file.stat.mtime })),
				{ target: config.target, quality: config.quality / 100, alpha: config.alpha, signal: controller.signal },
			);
			if (panel.disposed) { result.aborted = true; break; }
			if (partial.blockedReason) {
				new Notice(partial.reasonText ?? `转换未开始：${partial.blockedReason}`);
				return;
			}
			result.converted.push(...partial.converted);
			result.skipped.push(...partial.skipped);
			result.failed.push(...partial.failed);
			result.pendingTrash.push(...partial.pendingTrash);
			result.unrestored.push(...partial.unrestored);
			result.savedBytes += partial.savedBytes;
			result.aborted ||= partial.aborted;
			if (partial.keptNewFile) {
				result.keptNewFile = true;
				result.keptNewFilePath = partial.keptNewFilePath;
			}
			if (partial.aborted) break;
		}
		if (panel.disposed) return;
		// index 只在循环内可见；用已处理（成功+跳过+失败）的累计数更稳妥。
		panel.conversion.convertProgress = {
			processed: result.converted.length + result.skipped.length + result.failed.length,
			total: files.length,
		};
		const converted = result.converted.length;
		const failed = result.failed.length;
		const lastResult: ImageConversionResult & {
			unrestored?: string[];
			keptNewFile?: boolean;
			keptNewFilePath?: string;
		} = {
			converted,
			skipped: result.skipped.length,
			failed,
			savedBytes: result.savedBytes,
			unrestored: [...result.unrestored],
			keptNewFile: result.keptNewFile,
			keptNewFilePath: result.keptNewFilePath,
			aborted: result.aborted,
			pendingTrash: result.pendingTrash.map((item) => ({ path: item.path, newPath: item.newPath })),
			convertedItems: result.converted.map((item) => ({
				path: item.path,
				newPath: item.newPath,
				oldBytes: item.oldBytes,
				newBytes: item.newBytes,
			})),
			skippedItems: result.skipped.map((item) => ({
				path: item.path,
				reason: item.reason,
				reasonText: item.reasonText,
			})),
			failedItems: result.failed.map((item) => ({
				path: item.path,
				reason: item.reason,
				reasonText: item.reasonText,
			})),
		};
		panel.conversion.lastResult = lastResult;
		const convertedPaths = new Set(result.converted.map((item) => item.path));
		for (const path of convertedPaths) panel.convertSelections.delete(path);
		const prefix = result.aborted ? '转换已中止' : '转换完成';
		new Notice(`${prefix}：成功 ${panel.conversion.lastResult.converted}，跳过 ${panel.conversion.lastResult.skipped}，失败 ${failed}，实际节省 ${formatBytes(panel.conversion.lastResult.savedBytes)}。`);
		panel.saveCacheToSettings();
		await panel.scanTab('image-convert');
		await panel.scanTab('images');
		// 已转换（原图进回收站）的条目不应继续留在估算列表里。
		const remaining = new Set(panel.candidates.convertibleImages.map((file) => file.path));
		panel.conversion.items = panel.conversion.items.filter((item) => remaining.has(item.path));
		panel.renderContents();
	} catch (error) {
		if (!panel.disposed) new Notice(`转换失败：${reasonFor(error)}`);
	} finally {
		panel.conversion.converting = false;
		if (panel.convertController === controller) panel.convertController = undefined;
		if (!panel.disposed) panel.renderContents();
	}
}

export async function setConversionConfig(panel: CleanupConversionHost, patch: Partial<ImageConversionConfig>): Promise<void> {
	const previous = panel.conversion;
	const next = normalizeImageConversionConfig({ ...panel.conversionConfig(), ...patch });
	const sourcesChanged = next.sources.join(',') !== previous.sources.join(',');
	// 候选集同时取决于源格式与目标格式：目标变化时也要重新枚举。
	const targetChanged = next.target !== previous.target;
	panel.conversion = {
		...createConversionState(next),
		estimateProgress: previous.estimateProgress,
		convertProgress: previous.convertProgress,
		lastResult: previous.lastResult,
		converting: previous.converting,
	};
	panel.conversion.abort = () => abortEstimate(panel);
	panel.settings.imageConversion = cloneImageConversionConfig(next);
	if (sourcesChanged || targetChanged) {
		panel.candidates.convertibleImages = collectConvertibleImages(panel.app, next, panel.settings.orphanImageExtensions, panel.settings.orphanIgnoredFolders);
		panel.scannedTabs.add('image-convert');
		panel.dirtyTabs.delete('image-convert');
	}
	// 质量输入与配置调整会触发，合并成一次落盘，避免反复写 data.json。
	window.clearTimeout(panel.conversionSaveTimer);
	panel.conversionSaveTimer = window.setTimeout(() => {
		panel.conversionSaveTimer = 0;
		void panel.options.saveSettings?.();
	}, 300);
	panel.renderContents();
}
