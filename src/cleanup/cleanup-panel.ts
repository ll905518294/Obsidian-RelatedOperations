import { App, Component, Modal, Notice, TFile } from 'obsidian';
import { hasHiddenPathSegment, isIgnoredPath, parseExtensions, parseIgnoredFolders } from '../core-utils';
import { findBrokenImageLinks } from '../broken-image-links';
import { findBrokenNoteLinks } from '../broken-note-links';
import { findNativeImageLinks } from '../native-image-links';
import { findDuplicateFiles, removeFileReferencesForFiles, removeImageReferencesForFile, type DuplicateFileGroup } from '../duplicate-files';
import type { OrphanCleanupCache, RelatedOperationsSettings } from '../settings';
import { CLEANUP_CATEGORIES, type CleanupCandidates, type CleanupTab, type ImageGrouping, type OrphanCleanupHost, type OrphanCleanupOptions, type OrphanImageExtensions, type ScanCategoryTab, type ScanProgress, type ScanStage } from './cleanup-types';
import { byPath, reasonFor } from './cleanup-actions';
import { findCleanupCandidates, findEmptyFiles, findRecursivelyEmptyFolders, markFilesReferencedByText, referencedByCanvas } from './cleanup-scan';
import { CleanupConfirmationModal } from './cleanup-modals';
import { categoryStatus, renderHelp, renderOverview, renderProcessedSummary, renderTabs, tabEntries, updateScanProgress } from './cleanup-dashboard';
import { renderActions, renderList, updateSelectionSummary } from './cleanup-list-ui';
import { revalidateCleanupSelection } from './cleanup-flows';
export class OrphanCleanupPanel extends Component {
	candidates: CleanupCandidates = { images: [], attachments: [], emptyFiles: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], duplicates: [], duplicateWarnings: [] };
	selections = new Set<string>();
	linkSelections = new Set<string>();
	nativeSelections = new Set<string>();
	noteLinkSelections = new Set<string>();
	duplicateSelections = new Set<string>();
	activeTab: CleanupTab = 'overview';
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
		private readonly options: OrphanCleanupOptions = {},
	) { super(); }

	onload() {
		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			this.markContentDependentTabsDirty(file);
			if (!this.hasScanned || this.scanning) return;
			const before = this.linkResultsKey();
			this.refreshSourceLinks([file]);
			if (before === this.linkResultsKey()) return;
			this.saveCacheToSettings();
			if (['overview', 'broken-links', 'native-links', 'broken-note-links'].includes(this.activeTab)) this.renderContents();
			else this.updateTabCounts();
		}));
		this.registerEvent(this.app.metadataCache.on('resolved', () => {
			this.markTabDirty('images');
			this.markTabDirty('attachments');
			this.markTabDirty('empty-files');
			this.markTabDirty('native-links');
			if (!this.hasScanned || this.scanning) return;
			const before = this.linkResultsKey();
			this.candidates.brokenLinks = this.candidates.brokenLinks.filter((link) => !this.app.metadataCache.getFirstLinkpathDest(link.linkPath, link.sourcePath));
			this.candidates.brokenNoteLinks = this.candidates.brokenNoteLinks.filter((link) => !this.app.metadataCache.getFirstLinkpathDest(link.linkPath, link.sourcePath));
			if (before === this.linkResultsKey()) return;
			this.saveCacheToSettings();
			if (['overview', 'broken-links', 'native-links', 'broken-note-links'].includes(this.activeTab)) this.renderContents();
			else this.updateTabCounts();
		}));
		const markVaultChange = () => {
			for (const tab of ['images', 'attachments', 'empty-files', 'folders', 'duplicates', 'broken-links', 'native-links', 'broken-note-links'] as const) this.markTabDirty(tab);
		};
		this.registerEvent(this.app.vault.on('modify', markVaultChange));
		this.registerEvent(this.app.vault.on('create', markVaultChange));
		this.registerEvent(this.app.vault.on('delete', markVaultChange));
		this.registerEvent(this.app.vault.on('rename', markVaultChange));
	}

	private markContentDependentTabsDirty(file: TFile) {
		for (const tab of ['images', 'attachments', 'empty-files', 'duplicates'] as const) this.markTabDirty(tab);
		if (file.extension.toLowerCase() === 'md') this.markTabDirty('native-links');
	}

	private markTabDirty(tab: CleanupTab) {
		this.dirtyTabs.add(tab);
		this.dirtyVersions.set(tab, (this.dirtyVersions.get(tab) ?? 0) + 1);
	}

	private linkResultsKey() {
		return JSON.stringify([this.candidates.brokenLinks, this.candidates.brokenNoteLinks,
			this.candidates.nativeLinks.map((link) => ({ ...link, file: link.file?.path }))]);
	}

	private refreshSourceLinks(files: TFile[]) {
		const before = this.linkResultsKey();
		const paths = new Set(files.map((file) => file.path));
		const extensions = this.settings.orphanImageExtensions;
		this.candidates.brokenLinks = [...this.candidates.brokenLinks.filter((link) => !paths.has(link.sourcePath)), ...findBrokenImageLinks(this.app, extensions, files)];
		this.candidates.nativeLinks = [...this.candidates.nativeLinks.filter((link) => !paths.has(link.sourcePath)), ...findNativeImageLinks(this.app, extensions, files)];
		this.candidates.brokenNoteLinks = [...this.candidates.brokenNoteLinks.filter((link) => !paths.has(link.sourcePath)), ...findBrokenNoteLinks(this.app, extensions, files)];
		const bySource = (a: { sourcePath: string; position: { start: { offset: number } } }, b: { sourcePath: string; position: { start: { offset: number } } }) => a.sourcePath.localeCompare(b.sourcePath) || a.position.start.offset - b.position.start.offset;
		this.candidates.brokenLinks.sort(bySource);
		this.candidates.nativeLinks.sort(bySource);
		this.candidates.brokenNoteLinks.sort(bySource);
		if (before === this.linkResultsKey()) return;
		// Link keys contain offsets; a content edit invalidates that source's selections.
		for (const selection of [this.linkSelections, this.nativeSelections, this.noteLinkSelections]) {
			for (const key of selection) if (paths.has(key.split('\u0000')[0]!)) selection.delete(key);
		}
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
		this.candidates = this.options.cachedCandidates!;
		this.hasScanned = true;
		for (const category of CLEANUP_CATEGORIES) this.scannedTabs.add(category.tab);
		this.processed = undefined;
		this.pages.clear();
		this.dirtyTabs.clear();
		this.dirtyVersions.clear();
		for (const tab of ['images', 'attachments', 'broken-links', 'native-links', 'broken-note-links', 'empty-files', 'folders', 'duplicates'] as const) this.markTabDirty(tab);
		this.renderContents();
	}

	saveCacheToSettings() {
		const cache: OrphanCleanupCache = {
			version: 1,
			scannedAt: new Date().toISOString(),
			candidates: this.candidates,
			settingsSnapshot: {
				orphanImageExtensions: this.settings.orphanImageExtensions,
				orphanIgnoredFolders: this.settings.orphanIgnoredFolders,
			},
		};
		void this.options.saveCache?.(cache);
	}

	dispose() {
		this.unload();
		this.scanGeneration++;
		this.scanning = false;
		window.clearInterval(this.scanTimer);
		this.scanTimer = 0;
	}

	async scan(preserveProcessed = false) {
		if (this.scanning || this.scanningTabs.size > 0) return;
		const generation = ++this.scanGeneration;
		if (!preserveProcessed) this.processed = undefined;
		this.scanning = true;
		this.activeTab = 'overview';
		this.scannedTabs.clear();
		this.scanStartedAt = performance.now();
		this.scanElapsedMs = 0;
		window.clearInterval(this.scanTimer);
		this.scanTimer = window.setInterval(() => {
			if (!this.scanning) return;
			this.scanElapsedMs = performance.now() - this.scanStartedAt;
			this.updateScanProgress();
		}, 250);
		this.selections.clear();
		this.linkSelections.clear();
		this.nativeSelections.clear();
		this.noteLinkSelections.clear();
		this.duplicateSelections.clear();
		this.pages.clear();
		this.dirtyTabs.clear();
		this.dirtyVersions.clear();
		this.scanningTabs.clear();
		const startedAt = performance.now();
		this.scanStages = ['扫描资料库文件', '分析引用关系', '检查文本引用', '检查空文件与文件夹', '检查链接健康度', '检查重复文件'].map((label, index) => ({ label, state: index === 0 ? 'scanning' : 'pending', elapsedMs: 0, startedAt: index === 0 ? startedAt : undefined }));
		this.scanProgress = { stage: 0, processed: 0, total: 0 };
		this.renderContents();
		try {
			const candidates = await findCleanupCandidates(this.app, this.settings.orphanImageExtensions, this.settings.orphanIgnoredFolders, (progress) => {
				if (generation !== this.scanGeneration) return;
				const stageChanged = this.scanProgress.stage !== progress.stage;
				const previousStage = this.scanProgress.stage;
				this.scanProgress = progress;
				if (stageChanged) {
					const now = performance.now();
					const previous = this.scanStages[previousStage];
					if (previous?.startedAt) previous.elapsedMs = now - previous.startedAt;
					const current = this.scanStages[progress.stage];
					if (current && !current.startedAt) current.startedAt = now;
					this.scanStages.forEach((item, index) => { item.state = index < progress.stage ? 'done' : index === progress.stage ? 'scanning' : 'pending'; });
					this.updateScanProgress();
				}
				this.updateScanProgress();
			}, true, (tabs, results) => {
				if (generation !== this.scanGeneration) return;
				Object.assign(this.candidates, results);
				for (const tab of tabs) this.scannedTabs.add(tab);
				this.renderContents();
			});
			if (generation !== this.scanGeneration) return;
			this.candidates = candidates;
			this.hasScanned = true;
			for (const category of CLEANUP_CATEGORIES) this.scannedTabs.add(category.tab);
			this.renderContents();
		} catch (error) {
			if (generation !== this.scanGeneration) return;
			new Notice(`扫描失败：${reasonFor(error)}`);
			this.hasScanned = this.scannedTabs.size > 0;
			for (const category of CLEANUP_CATEGORIES) if (!this.scannedTabs.has(category.tab)) this.markTabDirty(category.tab);
			this.renderContents();
		} finally {
			if (generation === this.scanGeneration) {
				this.scanning = false;
				this.scanElapsedMs = performance.now() - this.scanStartedAt;
				window.clearInterval(this.scanTimer);
				const now = performance.now();
				const current = this.scanStages[this.scanProgress.stage];
				if (current?.startedAt) current.elapsedMs = now - current.startedAt;
				this.scanStages.forEach((item) => { item.state = 'done'; });
				this.renderContents();
			}
		}
	}

	renderContents() {
		this.contentEl.empty();
		this.renderTabs();
		if (this.showHelp) this.renderHelp();
		if (this.processed) this.renderProcessedSummary();
		if (this.activeTab === 'overview') {
			this.renderOverview();
			return;
		}
		this.renderList();
		this.renderActions();
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
		if (!await new CleanupConfirmationModal(this.app, 0, 0, 1, 0).waitForConfirmation()) return;
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

	async activateTab(tab: CleanupTab) {
		if (this.scanning) return;
		if (this.activeTab === tab) {
			const pending = this.categoryScans.get(tab);
			if (pending) return pending;
		}
		this.activeTab = tab;
		if (tab !== 'overview' && (this.dirtyTabs.has(tab) || !this.scannedTabs.has(tab) || this.scanningTabs.has(tab))) await this.scanCategory(tab);
		else this.renderContents();
	}

	async refreshCurrentTab() {
		if (this.activeTab !== 'overview') await this.scanCategory(this.activeTab);
	}

	async scanTab(tab: CleanupTab) {
		const scanVersion = this.dirtyVersions.get(tab) ?? 0;
		try {
			switch (tab) {
				case 'images':
				case 'attachments': {
					const extensions = parseExtensions(this.settings.orphanImageExtensions);
					const ignoredFolders = parseIgnoredFolders(this.settings.orphanIgnoredFolders);
					const visibleFiles = this.app.vault.getFiles().filter((file) => !hasHiddenPathSegment(file.path) && !isIgnoredPath(file.path, ignoredFolders));
					const attachmentFiles = visibleFiles.filter((file) => !['md', 'canvas'].includes(file.extension.toLowerCase()));
					const images = attachmentFiles.filter((file) => extensions.has(file.extension.toLowerCase()));
					const attachments = attachmentFiles.filter((file) => !extensions.has(file.extension.toLowerCase()));
					const referenced = await this.buildReferencedSet();
					await markFilesReferencedByText(this.app, [...images, ...attachments], referenced);
					if (tab === 'images') {
						this.candidates.images = images.filter((file) => !referenced.has(file.path)).sort(byPath);
					} else {
						this.candidates.attachments = attachments.filter((file) => !referenced.has(file.path)).sort(byPath);
					}
					break;
				}
				case 'broken-links':
					this.candidates.brokenLinks = findBrokenImageLinks(this.app, this.settings.orphanImageExtensions);
					break;
				case 'native-links':
					this.candidates.nativeLinks = findNativeImageLinks(this.app, this.settings.orphanImageExtensions);
					break;
				case 'broken-note-links':
					this.candidates.brokenNoteLinks = findBrokenNoteLinks(this.app, this.settings.orphanImageExtensions);
					break;
				case 'empty-files': {
					const extensions = parseExtensions(this.settings.orphanImageExtensions);
					const ignoredFolders = parseIgnoredFolders(this.settings.orphanIgnoredFolders);
					const visibleFiles = this.app.vault.getFiles().filter((file) => !hasHiddenPathSegment(file.path) && !isIgnoredPath(file.path, ignoredFolders));
					const referenced = await this.buildReferencedSet();
					await markFilesReferencedByText(this.app, [], referenced);
					this.candidates.emptyFiles = (await findEmptyFiles(visibleFiles, extensions, this.app)).filter((file) => !referenced.has(file.path));
					break;
				}
				case 'folders': {
					const ignoredFolders = parseIgnoredFolders(this.settings.orphanIgnoredFolders);
					this.candidates.folders = findRecursivelyEmptyFolders(this.app.vault.getRoot(), ignoredFolders).sort((a, b) => b.path.length - a.path.length || byPath(a, b));
					break;
				}
				case 'duplicates': {
					const result = await findDuplicateFiles(this.app, this.settings.orphanIgnoredFolders);
					this.candidates.duplicates = result.groups;
					this.candidates.duplicateWarnings = result.warnings;
					break;
				}
			}
			if (tab !== 'overview') {
				this.scannedTabs.add(tab);
				this.hasScanned = true;
			}
			if ((this.dirtyVersions.get(tab) ?? 0) === scanVersion) this.dirtyTabs.delete(tab);
		} catch (error) {
			this.markTabDirty(tab);
			new Notice(`刷新 ${this.getTabLabel(tab)} 失败：${reasonFor(error)}`);
		}
	}

	async scanCategory(tab: ScanCategoryTab) {
		if (this.scanning) return;
		const pending = this.categoryScans.get(tab);
		if (pending) {
			this.renderContents();
			return pending;
		}
		this.scanningTabs.add(tab);
		this.renderContents();
		const generation = this.scanGeneration;
		// Yield so the selected tab and refresh status can paint before scanning.
		const task = new Promise<void>((resolve) => window.setTimeout(resolve, 0)).then(async () => {
			if (generation === this.scanGeneration) await this.scanTab(tab);
		});
		this.categoryScans.set(tab, task);
		try {
			await task;
		} finally {
			this.categoryScans.delete(tab);
			this.scanningTabs.delete(tab);
		}
		if (generation !== this.scanGeneration) return;
		this.saveCacheToSettings();
		if (this.activeTab === tab || this.activeTab === 'overview') this.renderContents();
		else this.updateTabCounts();
	}

	private getTabLabel(tab: CleanupTab): string {
		const labels: Record<string, string> = {
			images: '未引用图片', attachments: '未引用附件',
			'broken-links': '失效图片链接', 'native-links': '原生图片链接',
			'broken-note-links': '失效笔记链接', 'empty-files': '空文件',
			'folders': '空文件夹', 'duplicates': '重复文件',
		};
		return labels[tab] ?? tab;
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

	private updateTabCounts() {
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

	private async buildReferencedSet(): Promise<Set<string>> {
		const referenced = new Set<string>();
		for (const [sourcePath, destinations] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			if (!sourcePath.toLowerCase().endsWith('.md')) continue;
			for (const path of Object.keys(destinations)) referenced.add(path);
		}
		const canvases = this.app.vault.getFiles().filter((file) => file.extension.toLowerCase() === 'canvas');
		for (const canvas of canvases) {
			for (const path of await referencedByCanvas(this.app, canvas)) referenced.add(path);
		}
		return referenced;
	}
	private renderTabs() { renderTabs(this); }
	private renderHelp() { renderHelp(this); }
	private renderProcessedSummary() { renderProcessedSummary(this); }
	private renderOverview() { renderOverview(this); }
	private updateScanProgress() { updateScanProgress(this); }
	private renderList() { renderList(this); }
	private renderActions() { renderActions(this); }
	updateSelectionSummary(summary?: HTMLElement) { updateSelectionSummary(this, summary); }
	private categoryStatus(count: number, scanned: boolean, scanning: boolean, dirty: boolean): string { return categoryStatus(count, scanned, scanning, dirty); }
	private tabEntries(): Array<[CleanupTab, string, number]> { return tabEntries(this.candidates, this.scanning); }
}

export class OrphanCleanupModal extends Modal {
	private panel?: OrphanCleanupPanel;

	constructor(app: App, private readonly settings: RelatedOperationsSettings, private readonly saveCache: (cache: OrphanCleanupCache) => Promise<void>) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('orphan-cleanup-dialog');
		this.titleEl.setText('Vault 体检与清理');
		const options: OrphanCleanupOptions = {
			cachedCandidates: this.settings.orphanCleanupCache?.candidates,
			cachedSettings: this.settings.orphanCleanupCache?.settingsSnapshot,
			saveCache: this.saveCache,
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
