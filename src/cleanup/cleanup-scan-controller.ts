import { App, Notice, TFile } from 'obsidian';
import { parseIgnoredFolders } from '../core-utils';
import { findBrokenImageLinks } from '../broken-image-links';
import { findBrokenNoteLinks } from '../broken-note-links';
import { findNativeImageLinks } from '../native-image-links';
import { findWikiNoteLinks } from '../wiki-note-links';
import { findDuplicateFiles } from '../duplicate-files';
import {
	CLEANUP_CATEGORIES,
	isCleanupScanAborted,
	type CleanupCandidates,
	type CleanupScanError,
	type CleanupTab,
	type ImageConversionState,
	type OrphanImageExtensions,
	type ScanCategoryTab,
	type ScanProgress,
	type ScanStage,
} from './cleanup-types';
import { collectCleanupFileSets, collectConvertibleImages, findCleanupCandidates, findEmptyFiles, findRecursivelyEmptyFolders, markFilesReferencedByText } from './cleanup-scan';
import { byPath, reasonFor } from './cleanup-actions';

/**
 * Full-scan and per-category scan orchestration for OrphanCleanupPanel.
 * The panel keeps its state; this module only owns the scan flows so the
 * panel can stay focused on rendering and selection.
 */
export interface CleanupScanHost {
	app: App;
	settings: OrphanImageExtensions;
	candidates: CleanupCandidates;
	conversion: ImageConversionState;
	activeTab: CleanupTab;
	scanning: boolean;
	hasScanned: boolean;
	scanGeneration: number;
	scanStartedAt: number;
	scanElapsedMs: number;
	scanTimer: number;
	scanStages: ScanStage[];
	scanProgress: ScanProgress;
	scannedTabs: Set<CleanupTab>;
	scanningTabs: Set<CleanupTab>;
	dirtyTabs: Set<CleanupTab>;
	dirtyVersions: Map<CleanupTab, number>;
	categoryScans: Map<CleanupTab, Promise<void>>;
	pages: Map<string, number>;
	selections: Set<string>;
	convertSelections: Set<string>;
	linkSelections: Set<string>;
	nativeSelections: Set<string>;
	noteLinkSelections: Set<string>;
	wikiSelections: Set<string>;
	duplicateSelections: Set<string>;
	processed?: { success: number; skipped: number; failed: Array<{ path: string; reason: string }> };
	lastScanError?: CleanupScanError;
	lastScanAborted?: boolean;
	lastScannedAt?: string;
	showingCachedResult?: boolean;
	scanController?: AbortController;
	markTabDirty(tab: CleanupTab): void;
	buildReferencedSet(): Promise<Set<string>>;
	renderContents(): void;
	updateScanProgress(): void;
	updateTabCounts(): void;
	saveCacheToSettings(): void;
	scanTab(tab: CleanupTab): Promise<void>;
}

/*
 * 同一个面板同时只允许一次全量扫描。并发调用直接复用进行中的任务，
 * 避免重复扫描（以及第二次调用被静默丢弃）。
 */
const activeFullScans = new WeakMap<CleanupScanHost, Promise<void>>();
const CONVERSION_BUSY_NOTICE = '图片压缩进行中，请先完成或中止压缩。';

export function runFullScan(panel: CleanupScanHost, preserveProcessed = false): Promise<void> {
	const active = activeFullScans.get(panel);
	if (active) return active;
	if (panel.conversion.converting) {
		new Notice(CONVERSION_BUSY_NOTICE);
		return Promise.resolve();
	}
	const task = executeFullScan(panel, preserveProcessed).finally(() => {
		if (activeFullScans.get(panel) === task) activeFullScans.delete(panel);
	});
	activeFullScans.set(panel, task);
	return task;
}

async function executeFullScan(panel: CleanupScanHost, preserveProcessed = false): Promise<void> {
	const requestGeneration = panel.scanGeneration;
	if (panel.scanningTabs.size > 0) {
		// 单分类刷新是短任务；等它结束后再执行用户请求的全量扫描，
		// 而不是静默丢弃这次请求。
		await Promise.allSettled([...panel.categoryScans.values()]);
		// 等待期间面板被关闭（dispose 会递增 generation）时不要再启动。
		if (panel.scanGeneration !== requestGeneration) return;
	}
	if (panel.conversion.converting) {
		new Notice(CONVERSION_BUSY_NOTICE);
		return;
	}
	if (panel.scanning) return;
	panel.lastScanError = undefined;
	panel.lastScanAborted = undefined;
	panel.showingCachedResult = false;
	const generation = ++panel.scanGeneration;
	const controller = new AbortController();
	panel.scanController = controller;
	if (!preserveProcessed) panel.processed = undefined;
	panel.scanning = true;
	panel.activeTab = 'overview';
	panel.scannedTabs.clear();
	panel.scanStartedAt = performance.now();
	panel.scanElapsedMs = 0;
	window.clearInterval(panel.scanTimer);
	panel.scanTimer = window.setInterval(() => {
		if (!panel.scanning) return;
		panel.scanElapsedMs = performance.now() - panel.scanStartedAt;
		panel.updateScanProgress();
	}, 250);
	panel.selections.clear();
	panel.convertSelections.clear();
	panel.linkSelections.clear();
	panel.nativeSelections.clear();
	panel.noteLinkSelections.clear();
	panel.wikiSelections.clear();
	panel.duplicateSelections.clear();
	panel.pages.clear();
	panel.dirtyTabs.clear();
	panel.dirtyVersions.clear();
	panel.scanningTabs.clear();
	const startedAt = performance.now();
	panel.scanStages = ['扫描资料库文件', '分析引用关系', '检查文本引用', '检查空文件与文件夹', '检查链接健康度', '检查重复文件'].map((label, index) => ({ label, state: index === 0 ? 'scanning' : 'pending', elapsedMs: 0, startedAt: index === 0 ? startedAt : undefined }));
	panel.scanProgress = { stage: 0, processed: 0, total: 0 };
	panel.renderContents();
	try {
		const candidates = await findCleanupCandidates(panel.app, panel.settings.orphanImageExtensions, panel.settings.orphanIgnoredFolders, (progress) => {
			if (generation !== panel.scanGeneration) return;
			const stageChanged = panel.scanProgress.stage !== progress.stage;
			const previousStage = panel.scanProgress.stage;
			panel.scanProgress = progress;
			if (stageChanged) {
				const now = performance.now();
				const previous = panel.scanStages[previousStage];
				if (previous?.startedAt) previous.elapsedMs = now - previous.startedAt;
				const current = panel.scanStages[progress.stage];
				if (current && !current.startedAt) current.startedAt = now;
				panel.scanStages.forEach((item, index) => { item.state = index < progress.stage ? 'done' : index === progress.stage ? 'scanning' : 'pending'; });
				panel.updateScanProgress();
			}
			panel.updateScanProgress();
		}, true, (tabs, results) => {
			if (generation !== panel.scanGeneration) return;
			Object.assign(panel.candidates, results);
			for (const tab of tabs) panel.scannedTabs.add(tab);
			panel.renderContents();
		}, controller.signal);
		if (generation !== panel.scanGeneration) return;
		panel.candidates = candidates;
		panel.hasScanned = true;
		for (const category of CLEANUP_CATEGORIES) panel.scannedTabs.add(category.tab);
		panel.lastScanError = undefined;
		panel.lastScanAborted = undefined;
		panel.saveCacheToSettings();
		panel.renderContents();
	} catch (error) {
		if (generation !== panel.scanGeneration) return;
		if (isCleanupScanAborted(error)) {
			panel.hasScanned = panel.scannedTabs.size > 0;
			for (const category of CLEANUP_CATEGORIES) if (!panel.scannedTabs.has(category.tab)) panel.markTabDirty(category.tab);
			panel.lastScanError = undefined;
			panel.lastScanAborted = true;
			// 中止后把已完成的分类落盘，重开面板时先看到本次结果，而不是上一次完整缓存。
			// 一个分类都没完成时没有可保留的结果，跳过写入以免覆盖上一次的完整缓存。
			if (panel.scannedTabs.size > 0) {
				panel.saveCacheToSettings();
				new Notice('已中止扫描：已完成的分类结果已保留。');
			} else {
				new Notice('已中止扫描：尚未完成任何分类，请重新开始扫描。');
			}
			return;
		}
		const reason = reasonFor(error);
		new Notice(`扫描失败：${reason}`);
		panel.hasScanned = panel.scannedTabs.size > 0;
		const failedTabs = CLEANUP_CATEGORIES
			.filter((category) => !panel.scannedTabs.has(category.tab))
			.map((category) => category.tab);
		for (const category of CLEANUP_CATEGORIES) if (!panel.scannedTabs.has(category.tab)) panel.markTabDirty(category.tab);
		panel.lastScanError = { reason, failedTabs };
		panel.renderContents();
	} finally {
		if (generation === panel.scanGeneration) {
			if (panel.scanController === controller) panel.scanController = undefined;
			panel.scanning = false;
			panel.scanElapsedMs = performance.now() - panel.scanStartedAt;
			window.clearInterval(panel.scanTimer);
			const now = performance.now();
			const current = panel.scanStages[panel.scanProgress.stage];
			if (current?.startedAt) current.elapsedMs = now - current.startedAt;
			if (panel.lastScanAborted) {
				for (const item of panel.scanStages) if (item.state === 'scanning') item.state = 'pending';
			} else {
				panel.scanStages.forEach((item) => { item.state = 'done'; });
			}
			panel.renderContents();
		}
	}
}

export async function scanCategory(panel: CleanupScanHost, tab: ScanCategoryTab): Promise<void> {
	if (panel.scanning) return;
	const pending = panel.categoryScans.get(tab);
	if (pending) {
		panel.renderContents();
		return pending;
	}
	panel.scanningTabs.add(tab);
	panel.renderContents();
	const generation = panel.scanGeneration;
	// Yield so the selected tab and refresh status can paint before scanning.
	const task = new Promise<void>((resolve) => window.setTimeout(resolve, 0)).then(async () => {
		if (generation === panel.scanGeneration) await panel.scanTab(tab);
	});
	panel.categoryScans.set(tab, task);
	try {
		await task;
	} finally {
		panel.categoryScans.delete(tab);
		panel.scanningTabs.delete(tab);
	}
	if (generation !== panel.scanGeneration) return;
	panel.saveCacheToSettings();
	if (panel.activeTab === tab || panel.activeTab === 'overview') panel.renderContents();
	else panel.updateTabCounts();
}

export async function scanTab(panel: CleanupScanHost, tab: CleanupTab): Promise<void> {
	const scanVersion = panel.dirtyVersions.get(tab) ?? 0;
	try {
		switch (tab) {
			case 'images':
			case 'attachments': {
				const { images, attachments } = collectCleanupFileSets(panel.app, panel.settings.orphanImageExtensions, panel.settings.orphanIgnoredFolders);
				const referenced = await panel.buildReferencedSet();
				await markFilesReferencedByText(panel.app, [...images, ...attachments], referenced);
				if (tab === 'images') {
					panel.candidates.images = images.filter((file) => !referenced.has(file.path)).sort(byPath);
				} else {
					panel.candidates.attachments = attachments.filter((file) => !referenced.has(file.path)).sort(byPath);
				}
				break;
			}
			case 'broken-links':
				panel.candidates.brokenLinks = findBrokenImageLinks(panel.app, panel.settings.orphanImageExtensions);
				break;
			case 'native-links':
				panel.candidates.nativeLinks = findNativeImageLinks(panel.app, panel.settings.orphanImageExtensions);
				break;
			case 'broken-note-links':
				panel.candidates.brokenNoteLinks = findBrokenNoteLinks(panel.app, panel.settings.orphanImageExtensions);
				break;
			case 'wiki-links':
				panel.candidates.wikiLinks = findWikiNoteLinks(panel.app);
				break;
			case 'empty-files': {
				const { extensions, visibleFiles } = collectCleanupFileSets(panel.app, panel.settings.orphanImageExtensions, panel.settings.orphanIgnoredFolders);
				const referenced = await panel.buildReferencedSet();
				await markFilesReferencedByText(panel.app, [], referenced);
				panel.candidates.emptyFiles = (await findEmptyFiles(visibleFiles, extensions, panel.app)).filter((file) => !referenced.has(file.path));
				break;
			}
			case 'folders': {
				const ignoredFolders = parseIgnoredFolders(panel.settings.orphanIgnoredFolders);
				panel.candidates.folders = findRecursivelyEmptyFolders(panel.app.vault.getRoot(), ignoredFolders).sort((a, b) => b.path.length - a.path.length || byPath(a, b));
				break;
			}
			case 'duplicates': {
				const result = await findDuplicateFiles(panel.app, panel.settings.orphanIgnoredFolders);
				panel.candidates.duplicates = result.groups;
				panel.candidates.duplicateWarnings = result.warnings;
				break;
			}
			case 'image-convert':
				// 只枚举候选，不解码也不估算体积；估算由用户手动触发。
				panel.candidates.convertibleImages = collectConvertibleImages(
					panel.app,
					panel.conversion,
					panel.settings.orphanImageExtensions,
					panel.settings.orphanIgnoredFolders,
				);
				break;
		}
		if (tab !== 'overview') {
			panel.scannedTabs.add(tab);
			panel.hasScanned = true;
		}
		if ((panel.dirtyVersions.get(tab) ?? 0) === scanVersion) panel.dirtyTabs.delete(tab);
	} catch (error) {
		panel.markTabDirty(tab);
		new Notice(`刷新 ${getTabLabel(tab)} 失败：${reasonFor(error)}`);
	}
}

function getTabLabel(tab: CleanupTab): string {
	if (tab === 'overview') return '体检首页';
	if (tab === 'image-convert') return '图片压缩';
	return CLEANUP_CATEGORIES.find((category) => category.tab === tab)?.label ?? tab;
}

export function linkResultsKey(panel: Pick<CleanupScanHost, 'candidates'>): string {
	return JSON.stringify([panel.candidates.brokenLinks, panel.candidates.brokenNoteLinks,
		panel.candidates.wikiLinks.map((link) => ({ ...link, file: link.file?.path })),
		panel.candidates.nativeLinks.map((link) => ({ ...link, file: link.file?.path }))]);
}

export function markContentDependentTabsDirty(panel: Pick<CleanupScanHost, 'markTabDirty'>, file: TFile) {
	for (const tab of ['images', 'attachments', 'empty-files', 'duplicates', 'image-convert'] as const) panel.markTabDirty(tab);
	if (file.extension.toLowerCase() === 'md') {
		panel.markTabDirty('native-links');
		panel.markTabDirty('wiki-links');
	}
}

export function refreshSourceLinks(panel: CleanupScanHost, files: TFile[]) {
	const before = linkResultsKey(panel);
	const paths = new Set(files.map((file) => file.path));
	const extensions = panel.settings.orphanImageExtensions;
	panel.candidates.brokenLinks = [...panel.candidates.brokenLinks.filter((link) => !paths.has(link.sourcePath)), ...findBrokenImageLinks(panel.app, extensions, files)];
	panel.candidates.nativeLinks = [...panel.candidates.nativeLinks.filter((link) => !paths.has(link.sourcePath)), ...findNativeImageLinks(panel.app, extensions, files)];
	panel.candidates.brokenNoteLinks = [...panel.candidates.brokenNoteLinks.filter((link) => !paths.has(link.sourcePath)), ...findBrokenNoteLinks(panel.app, extensions, files)];
	panel.candidates.wikiLinks = [...panel.candidates.wikiLinks.filter((link) => !paths.has(link.sourcePath)), ...findWikiNoteLinks(panel.app, files)];
	const bySource = (a: { sourcePath: string; position: { start: { offset: number } } }, b: { sourcePath: string; position: { start: { offset: number } } }) => a.sourcePath.localeCompare(b.sourcePath) || a.position.start.offset - b.position.start.offset;
	panel.candidates.brokenLinks.sort(bySource);
	panel.candidates.nativeLinks.sort(bySource);
	panel.candidates.brokenNoteLinks.sort(bySource);
	panel.candidates.wikiLinks.sort(bySource);
	if (before === linkResultsKey(panel)) return;
	// Link keys contain offsets; a content edit invalidates that source's selections.
	for (const selection of [panel.linkSelections, panel.nativeSelections, panel.noteLinkSelections, panel.wikiSelections]) {
		for (const key of selection) if (paths.has(key.split('\u0000')[0]!)) selection.delete(key);
	}
}
