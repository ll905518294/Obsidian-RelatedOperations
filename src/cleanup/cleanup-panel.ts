import { App, Component, Modal, Notice, TFile } from 'obsidian';
import { parseIgnoredFolders } from '../core-utils';
import { removeFileReferencesForFiles, removeImageReferencesForFile, type DuplicateFileGroup } from '../duplicate-files';
import type { RelatedOperationsSettings } from '../settings';
import { CLEANUP_CATEGORIES, cloneImageConversionConfig, normalizeImageConversionConfig, type CleanupCandidates, type CleanupScanError, type CleanupTab, type ImageConversionConfig, type ImageConversionState, type ImageGrouping, type OrphanCleanupHost, type OrphanCleanupOptions, type OrphanImageExtensions, type ScanCategoryTab, type ScanProgress, type ScanStage } from './cleanup-types';
import { createCleanupCache, restoreCleanupCandidates, type OrphanCleanupCache } from './cleanup-cache';
import { byPath, reasonFor } from './cleanup-actions';
import { findRecursivelyEmptyFolders, referencedByCanvas } from './cleanup-scan';
import { categoryStatus, renderHelp, renderOverview, renderProcessedSummary, renderTabs, tabEntries, updateScanProgress } from './cleanup-dashboard';
import { renderActions, renderList, updateSelectionSummary } from './cleanup-list-ui';
import { clearConversionSelections, isConversionTab, renderConversionList } from './cleanup-list-convert';
import { renderConversionActions } from './cleanup-list-convert-actions';
import { revalidateCleanupSelection } from './cleanup-flows';
import { reportCleanupInvariants } from './cleanup-invariants';
import { captureViewSnapshot, restoreViewSnapshot } from './cleanup-focus';
import { createCanvasImageCodec, type ImageCodec } from '../image-convert/image-codec';
import { createConversionState, estimateConversions as runEstimateConversions, abortEstimate as runAbortEstimate, abortConvert as runAbortConvert, convertSelected as runConvertSelected, setConversionConfig as runSetConversionConfig } from './cleanup-conversion-controller';
import { linkResultsKey, markContentDependentTabsDirty, refreshSourceLinks, runFullScan, scanCategory as runScanCategory, scanTab as runScanTab } from './cleanup-scan-controller';

export class OrphanCleanupPanel extends Component {
	candidates: CleanupCandidates = { images: [], attachments: [], emptyFiles: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [], duplicates: [], duplicateWarnings: [], convertibleImages: [] };
	selections = new Set<string>();
	convertSelections = new Set<string>();
	linkSelections = new Set<string>();
	nativeSelections = new Set<string>();
	noteLinkSelections = new Set<string>();
	wikiSelections = new Set<string>();
	duplicateSelections = new Set<string>();
	activeTab: CleanupTab = 'overview';
	conversion: ImageConversionState;
	imageGrouping: ImageGrouping = 'none';
	attachmentGrouping: ImageGrouping = 'none';
	scanning = false;
	hasScanned = false;
	scanStages: ScanStage[] = [];
	scanProgress: ScanProgress = { stage: 0, processed: 0, total: 0 };
	scanGeneration = 0;
	scanStartedAt = 0;
	scanElapsedMs = 0;
	scanTimer = 0;
	showHelp = false;
	pages = new Map<string, number>();
	processed?: { success: number; skipped: number; failed: Array<{ path: string; reason: string }> };
	lastScanError?: CleanupScanError;
	lastScanAborted?: boolean;
	lastScannedAt?: string;
	showingCachedResult = false;
	scanController?: AbortController;
	private codecInstance?: ImageCodec;
	private lastCacheSaveError?: string;
	estimateController?: AbortController;
	convertController?: AbortController;
	conversionSaveTimer = 0;
	private lastRenderedView?: string;
	dirtyTabs = new Set<CleanupTab>();
	dirtyVersions = new Map<CleanupTab, number>();
	scannedTabs = new Set<CleanupTab>();
	scanningTabs = new Set<CleanupTab>();
	categoryScans = new Map<CleanupTab, Promise<void>>();

	constructor(
		readonly app: App,
		readonly contentEl: HTMLElement,
		readonly settings: OrphanImageExtensions,
		private readonly host: OrphanCleanupHost,
		readonly options: OrphanCleanupOptions = {},
	) {
		super();
		this.conversion = createConversionState(normalizeImageConversionConfig(this.settings.imageConversion));
		this.conversion.abort = () => runAbortEstimate(this);
	}

	onload() {
		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			markContentDependentTabsDirty(this, file);
			if (!this.hasScanned || this.scanning) return;
			const before = linkResultsKey(this);
			refreshSourceLinks(this, [file]);
			if (before === linkResultsKey(this)) return;
			this.saveCacheToSettings();
			if (['overview', 'broken-links', 'native-links', 'broken-note-links', 'wiki-links'].includes(this.activeTab)) this.renderContents();
			else this.updateTabCounts();
		}));
		this.registerEvent(this.app.metadataCache.on('resolved', () => {
			this.markTabDirty('images');
			this.markTabDirty('attachments');
			this.markTabDirty('empty-files');
			this.markTabDirty('native-links');
			this.markTabDirty('wiki-links');
			if (!this.hasScanned || this.scanning) return;
			const before = linkResultsKey(this);
			this.candidates.brokenLinks = this.candidates.brokenLinks.filter((link) => !this.app.metadataCache.getFirstLinkpathDest(link.linkPath, link.sourcePath));
			this.candidates.brokenNoteLinks = this.candidates.brokenNoteLinks.filter((link) => !this.app.metadataCache.getFirstLinkpathDest(link.linkPath, link.sourcePath));
			if (before === linkResultsKey(this)) return;
			this.saveCacheToSettings();
			if (['overview', 'broken-links', 'native-links', 'broken-note-links', 'wiki-links'].includes(this.activeTab)) this.renderContents();
			else this.updateTabCounts();
		}));
		const markVaultChange = () => {
			for (const tab of ['images', 'attachments', 'empty-files', 'folders', 'duplicates', 'broken-links', 'native-links', 'broken-note-links', 'wiki-links', 'image-convert'] as const) this.markTabDirty(tab);
		};
		this.registerEvent(this.app.vault.on('modify', markVaultChange));
		this.registerEvent(this.app.vault.on('create', markVaultChange));
		this.registerEvent(this.app.vault.on('delete', markVaultChange));
		this.registerEvent(this.app.vault.on('rename', markVaultChange));
	}

	markTabDirty(tab: CleanupTab) {
		this.dirtyTabs.add(tab);
		this.dirtyVersions.set(tab, (this.dirtyVersions.get(tab) ?? 0) + 1);
	}

	async scan(preserveProcessed = false) {
		return runFullScan(this, preserveProcessed);
	}

	abortScan() {
		this.scanController?.abort();
	}

	async scanCategory(tab: ScanCategoryTab) {
		return runScanCategory(this, tab);
	}

	async scanTab(tab: CleanupTab) {
		return runScanTab(this, tab);
	}

	render() {
		this.load();
		this.contentEl.addClass('orphan-cleanup-panel');
		if (this.options.cachedCandidates) {
			this.restoreFromCache();
		} else {
			this.renderContents();
		}
	}

	private restoreFromCache() {
		// 缓存里只有路径；文件已删除或改名时按路径解析失败会安全丢弃。
		this.candidates = restoreCleanupCandidates(this.app, this.options.cachedCandidates);
		this.hasScanned = true;
		this.showingCachedResult = true;
		this.lastScannedAt = this.options.cachedAt;
		for (const category of CLEANUP_CATEGORIES) this.scannedTabs.add(category.tab);
		this.processed = undefined;
		this.pages.clear();
		this.dirtyTabs.clear();
		this.dirtyVersions.clear();
		for (const tab of ['images', 'attachments', 'broken-links', 'native-links', 'broken-note-links', 'wiki-links', 'empty-files', 'folders', 'duplicates', 'image-convert'] as const) this.markTabDirty(tab);
		this.renderContents();
	}

	saveCacheToSettings() {
		// 转换候选与估算结果不属于体检缓存，createCleanupCache 会强制写空。
		const cache = createCleanupCache(new Date().toISOString(), this.candidates, {
			orphanImageExtensions: this.settings.orphanImageExtensions,
			orphanIgnoredFolders: this.settings.orphanIgnoredFolders,
		});
		this.lastScannedAt = cache.scannedAt;
		this.persistCache(cache);
	}

	private persistCache(cache: OrphanCleanupCache) {
		let pending: Promise<void> | void;
		try {
			pending = this.options.saveCache?.(cache);
		} catch (error) {
			this.reportCacheSaveFailure(error);
			return;
		}
		if (!isPromiseLike(pending)) {
			this.lastCacheSaveError = undefined;
			return;
		}
		void pending.then(
			() => { this.lastCacheSaveError = undefined; },
			(error) => this.reportCacheSaveFailure(error),
		);
	}

	private reportCacheSaveFailure(error: unknown) {
		const reason = reasonFor(error);
		console.warn(`[vault-doctor] 缓存保存失败：${reason}`);
		// 文件事件会频繁触发缓存写入；同一错误只提示一次，成功后再重置。
		if (this.lastCacheSaveError === reason) return;
		this.lastCacheSaveError = reason;
		new Notice(`缓存保存失败：${reason}`);
	}

	dispose() {
		this.unload();
		this.scanGeneration++;
		this.scanning = false;
		this.scanController?.abort();
		this.scanController = undefined;
		this.estimateController?.abort();
		this.convertController?.abort();
		window.clearInterval(this.scanTimer);
		this.scanTimer = 0;
		if (this.conversionSaveTimer) {
			window.clearTimeout(this.conversionSaveTimer);
			this.conversionSaveTimer = 0;
			void this.options.saveSettings?.();
		}
	}

	renderContents() {
		const snapshot = captureViewSnapshot(this.contentEl);
		const view = this.renderedViewKey();
		const sameView = this.lastRenderedView === view;
		this.contentEl.empty();
		this.renderTabs();
		if (this.showHelp) this.renderHelp();
		if (this.processed) this.renderProcessedSummary();
		if (this.activeTab === 'overview') {
			this.renderOverview();
		} else {
			this.renderList();
			this.renderActions();
		}
		reportCleanupInvariants(this);
		if (snapshot) restoreViewSnapshot(this.contentEl, snapshot, sameView);
		this.lastRenderedView = view;
	}

	private renderedViewKey() {
		const page = this.activeTab === 'overview' ? 0 : this.pages.get(this.activeTab) ?? 0;
		return `${this.activeTab}:${page}`;
	}

	async cleanDuplicateLinks(file: DuplicateFileGroup['files'][number]) {
		const result = await removeImageReferencesForFile(this.app, file.path);
		new Notice(`已清理 ${result.removed} 条图片链接${result.failed.length ? `，失败 ${result.failed.length} 个文件` : ''}。`);
		if (result.removed) {
			this.saveCacheToSettings();
			this.renderContents();
		}
	}

	async deleteDuplicateFile(file: DuplicateFileGroup['files'][number]) {
		const target = this.app.vault.getAbstractFileByPath(file.path);
		if (!(target instanceof TFile)) { new Notice('文件不存在，请重新扫描。'); return; }
		try {
			const references = await removeFileReferencesForFiles(this.app, [file.path]);
			if (references.failed.length) { new Notice(`未删除文件：笔记链接清理失败（${references.failed.join('、')}）`); return; }
			await this.app.fileManager.trashFile(target);
			this.candidates.duplicates = this.candidates.duplicates
				.map((group) => ({ ...group, files: group.files.filter((item) => item.path !== file.path) }))
				.filter((group) => group.files.length > 1);
			this.duplicateSelections.delete(file.path);
			new Notice(`已移入回收站：${file.path}`);
			this.saveCacheToSettings();
			this.renderContents();
		} catch (error) { new Notice(`删除失败：${reasonFor(error)}`); }
	}

	async estimateConversions() {
		return runEstimateConversions(this);
	}

	abortEstimate() {
		runAbortEstimate(this);
	}

	abortConvert() {
		runAbortConvert(this);
	}

	async convertSelected() {
		return runConvertSelected(this);
	}

	async setConversionConfig(patch: Partial<ImageConversionConfig>) {
		return runSetConversionConfig(this, patch);
	}

	conversionConfig(): ImageConversionConfig {
		return cloneImageConversionConfig(this.conversion);
	}

	imageCodec(): ImageCodec {
		return this.codecInstance ??= createCanvasImageCodec();
	}

	async activateTab(tab: CleanupTab) {
		if (this.scanning) return;
		if (this.activeTab === tab) {
			const pending = this.categoryScans.get(tab);
			if (pending) return pending;
		}
		if (this.activeTab !== tab) clearConversionSelections(this);
		this.activeTab = tab;
		if (tab !== 'overview' && (this.dirtyTabs.has(tab) || !this.scannedTabs.has(tab) || this.scanningTabs.has(tab))) await this.scanCategory(tab);
		else this.renderContents();
	}

	async refreshCurrentTab() {
		if (this.activeTab !== 'overview') await this.scanCategory(this.activeTab);
	}

	async trashSingleImage(file: TFile) {
		try {
			const { files, skipped } = await revalidateCleanupSelection(this, [file.path], []);
			if (skipped.length || files.length === 0) {
				this.removeImage(file);
				new Notice(`未移动：${file.name} 已被引用或不存在。`);
				return;
			}
			await this.app.fileManager.trashFile(files[0]!);
			this.removeImage(file);
			new Notice(`已移入回收站：${file.name}`);
		} catch (error) {
			new Notice(`删除失败：${reasonFor(error)}`);
		}
	}

	async trashPreviewImage(file: TFile) {
		await this.trashSingleImage(file);
		this.renderContents();
	}

	private removeImage(file: TFile) {
		this.candidates.images = this.candidates.images.filter((item) => item.path !== file.path);
		this.candidates.folders = findRecursivelyEmptyFolders(this.app.vault.getRoot(), parseIgnoredFolders(this.settings.orphanIgnoredFolders)).sort((a, b) => b.path.length - a.path.length || byPath(a, b));
		this.selections.delete(file.path);
		for (const card of Array.from(this.contentEl.querySelectorAll<HTMLElement>('.orphan-cleanup-image-card'))) {
			if (card.dataset.path === file.path) card.remove();
		}
		this.updateImageGroupCounts();
		this.updateTabCounts();
		this.updateSelectionSummary();
		if (this.candidates.images.length === 0) this.renderContents();
	}

	updateTabCounts() {
		const tabs = this.contentEl.querySelector<HTMLElement>('.orphan-cleanup-tabs');
		if (!tabs) return;
		const focused = tabs.ownerDocument.activeElement;
		for (const [index, [tab, label, count]] of tabEntries(this.candidates, this.scanning).entries()) {
			const button = tabs.querySelector<HTMLElement>(`.orphan-cleanup-tab[data-tab="${tab}"]`);
			if (!button) continue;
			button.setText(`${label}（${count}）`);
			if (tabs.children[index] !== button) tabs.insertBefore(button, tabs.children[index] ?? null);
		}
		if (focused instanceof HTMLElement && tabs.contains(focused) && focused !== tabs.ownerDocument.activeElement) focused.focus({ preventScroll: true });
	}

	private updateImageGroupCounts() {
		for (const cards of Array.from(this.contentEl.querySelectorAll<HTMLElement>('.orphan-cleanup-grid-items'))) {
			const heading = cards.previousElementSibling;
			if (!(heading instanceof HTMLElement) || !heading.matches('.orphan-cleanup-grid-group')) continue;
			if (cards.children.length === 0) {
				heading.remove();
				cards.remove();
			} else {
				heading.setText(`${heading.textContent?.replace(/（\d+）$/, '')}（${cards.children.length}）`);
			}
		}
	}

	async buildReferencedSet(): Promise<Set<string>> {
		const referenced = new Set<string>();
		for (const [sourcePath, destinations] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			if (!sourcePath.toLowerCase().endsWith('.md')) continue;
			for (const path of Object.keys(destinations)) referenced.add(path);
		}
		const canvases = this.app.vault.getFiles().filter((file) => file.extension.toLowerCase() === 'canvas');
		let canvasParseFailed = false;
		for (const canvas of canvases) {
			const paths = await referencedByCanvas(this.app, canvas);
			if (paths === null) {
				canvasParseFailed = true;
			} else {
				for (const path of paths) referenced.add(path);
			}
		}
		if (canvasParseFailed) {
			for (const file of this.app.vault.getFiles()) {
				if (!['md', 'canvas'].includes(file.extension.toLowerCase())) referenced.add(file.path);
			}
		}
		return referenced;
	}
	private renderTabs() { renderTabs(this); }
	private renderHelp() { renderHelp(this); }
	private renderProcessedSummary() { renderProcessedSummary(this); }
	private renderOverview() { renderOverview(this); }
	updateScanProgress() { updateScanProgress(this); }
	private renderList() {
		if (isConversionTab(this.activeTab)) renderConversionList(this);
		else renderList(this);
	}
	private renderActions() {
		if (isConversionTab(this.activeTab)) renderConversionActions(this);
		else renderActions(this);
	}
	updateSelectionSummary(summary?: HTMLElement) { updateSelectionSummary(this, summary); }
	private categoryStatus(count: number, scanned: boolean, scanning: boolean, dirty: boolean): string { return categoryStatus(count, scanned, scanning, dirty); }
	private tabEntries(): Array<[CleanupTab, string, number]> { return tabEntries(this.candidates, this.scanning); }
}

export class OrphanCleanupModal extends Modal {
	private panel?: OrphanCleanupPanel;

	constructor(app: App, private readonly settings: RelatedOperationsSettings, private readonly saveCache: (cache: OrphanCleanupCache) => Promise<void>, private readonly saveSettings: () => Promise<void> = async () => {}) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('orphan-cleanup-dialog');
		this.titleEl.setText('Vault 体检与清理');
		const options: OrphanCleanupOptions = {
			cachedCandidates: this.settings.orphanCleanupCache?.candidates,
			cachedAt: this.settings.orphanCleanupCache?.scannedAt,
			cachedSettings: this.settings.orphanCleanupCache?.settingsSnapshot,
			saveCache: this.saveCache,
			saveSettings: this.saveSettings,
		};
		this.panel = new OrphanCleanupPanel(this.app, this.contentEl, this.settings, this, options);
		this.panel.render();
	}

	onClose() {
		this.modalEl.removeClass('orphan-cleanup-dialog');
		this.panel?.dispose();
		this.panel = undefined;
		this.contentEl.empty();
	}
}

function isPromiseLike(value: unknown): value is Promise<void> {
	return (typeof value === 'object' || typeof value === 'function')
		&& value !== null
		&& typeof (value as { then?: unknown }).then === 'function';
}
