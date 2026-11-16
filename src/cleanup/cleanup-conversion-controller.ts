import { Notice } from 'obsidian';
import type { ImageCodec } from '../image-convert/image-codec';
import { runImageConversion, type ConversionApp, type ConversionResult } from '../image-convert/image-convert-runner';
import { collectConvertibleImages, estimateConversions as estimateConversionCosts } from './cleanup-scan';
import { clearConversionSelections } from './cleanup-list-convert';
import { formatBytes, reasonFor } from './cleanup-actions';
import {
	normalizeImageConversionConfig,
	type CleanupViewContext,
	type ImageConversionConfig,
	type ImageConversionResult,
	type ImageConversionState,
	type OrphanCleanupOptions,
} from './cleanup-types';

// 修复期先串行转换：两个 worker 同时改写同一篇笔记会互相覆盖回滚。
const CONVERSION_BATCH_SIZE = 1;

export function createConversionState(config: ImageConversionConfig): ImageConversionState {
	return {
		...config,
		sources: [...config.sources],
		config: { ...config, sources: [...config.sources] },
		items: [],
		estimating: false,
		converting: false,
		estimateProgress: { processed: 0, total: 0 },
	};
}

/**
 * Image conversion flows for OrphanCleanupPanel: estimate, convert and config
 * updates. The panel keeps its conversion state; this module owns the flows.
 */
export interface CleanupConversionHost extends CleanupViewContext {
	options: OrphanCleanupOptions;
	estimateController?: AbortController;
	convertController?: AbortController;
	conversionSaveTimer: number;
	conversionConfig(): ImageConversionConfig;
	imageCodec(): ImageCodec;
}

export async function estimateConversions(panel: CleanupConversionHost): Promise<void> {
	clearConversionSelections(panel);
	if (panel.conversion.estimating) return;
	const files = panel.candidates.convertibleImages;
	if (files.length === 0) { new Notice('没有符合条件的图片；请先扫描候选。'); return; }
	const controller = new AbortController();
	panel.estimateController = controller;
	panel.conversion.estimating = true;
	panel.conversion.estimateProgress = { processed: 0, total: files.length };
	panel.renderContents();
	let lastPaint = 0;
	try {
		const items = await estimateConversionCosts(panel.app, files, panel.conversionConfig(), panel.imageCodec(), (progress) => {
			panel.conversion.estimateProgress = progress;
			const now = performance.now();
			// 大批量图片时避免每个进度都重建整页 DOM。
			if (panel.activeTab !== 'image-convert' || (now - lastPaint < 150 && progress.processed < progress.total)) return;
			lastPaint = now;
			panel.renderContents();
		}, controller.signal);
		panel.conversion.items = items;
	} catch (error) {
		new Notice(`估算失败：${reasonFor(error)}`);
	} finally {
		panel.conversion.estimating = false;
		if (panel.estimateController === controller) panel.estimateController = undefined;
		panel.renderContents();
	}
}

export function abortEstimate(panel: CleanupConversionHost): void {
	panel.estimateController?.abort();
}

export function abortConvert(panel: CleanupConversionHost): void {
	panel.convertController?.abort();
}

export async function convertSelected(panel: CleanupConversionHost): Promise<void> {
	const selected = panel.candidates.convertibleImages.filter((file) => panel.convertSelections.has(file.path));
	if (selected.length === 0) { new Notice('请先选择要转换的图片。'); return; }
	const blocked = new Set(panel.conversion.items.filter((item) => item.blockedReason).map((item) => item.path));
	const files = selected.filter((file) => !blocked.has(file.path));
	if (files.length === 0) { new Notice('所选图片均已被标记为不可转换；请重新估算或取消选择。'); return; }
	if (panel.conversion.estimating || panel.conversion.converting) { new Notice('估算或转换正在进行，请稍后再试。'); return; }
	const controller = new AbortController();
	panel.convertController = controller;
	panel.conversion.converting = true;
	panel.renderContents();
	try {
		const config = panel.conversionConfig();
		const result: ConversionResult = { converted: [], skipped: [], failed: [], pendingTrash: [], savedBytes: 0, aborted: false, unrestored: [] };
		for (let index = 0; index < files.length; index += CONVERSION_BATCH_SIZE) {
			if (controller.signal.aborted) { result.aborted = true; break; }
			const batch = files.slice(index, index + CONVERSION_BATCH_SIZE);
			const partial = await runImageConversion(
				// Obsidian 的 App 在运行期满足 runner 需要的子集；vault.delete 的参数
				// 逆变让 TS 拒绝直接赋值，因此这里显式收窄。
				panel.app as unknown as ConversionApp,
				panel.imageCodec(),
				batch.map((file) => ({ path: file.path, size: file.stat.size, mtime: file.stat.mtime })),
				{ target: config.target, quality: config.quality / 100, alpha: config.alpha, signal: controller.signal },
			);
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
		new Notice(`转换失败：${reasonFor(error)}`);
	} finally {
		panel.conversion.converting = false;
		if (panel.convertController === controller) panel.convertController = undefined;
		panel.renderContents();
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
		lastResult: previous.lastResult,
		converting: previous.converting,
	};
	panel.conversion.abort = () => abortEstimate(panel);
	panel.settings.imageConversion = { ...next, sources: [...next.sources] };
	if (sourcesChanged || targetChanged) {
		panel.candidates.convertibleImages = collectConvertibleImages(panel.app, next, panel.settings.orphanImageExtensions, panel.settings.orphanIgnoredFolders);
		panel.scannedTabs.add('image-convert');
		panel.dirtyTabs.delete('image-convert');
	}
	// 质量滑杆会连续触发；合并成一次落盘，避免拖动时反复写 data.json。
	window.clearTimeout(panel.conversionSaveTimer);
	panel.conversionSaveTimer = window.setTimeout(() => {
		panel.conversionSaveTimer = 0;
		void panel.options.saveSettings?.();
	}, 300);
	panel.renderContents();
}
