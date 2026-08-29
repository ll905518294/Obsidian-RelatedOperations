import { FileSystemAdapter, Notice, Platform, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';
import { RelatedNotesModal } from './related-notes-modal';
import { getRelatedNotesForFiles } from './related-notes';
import { RELATED_NOTES_VIEW_TYPE, RelatedNotesView } from './related-notes-view';
import { NotebookNavigatorApi } from './notebook-navigator-api';
import { DEFAULT_SETTINGS, RelatedOperationsSettingTab, RelatedOperationsSettings } from './settings';
import { findLinkStatsPropertyConflicts, LinkStatsPropertyNames, migrateLinkStatsProperties, updateLinkStats } from './link-stats';
import { OrphanCleanupModal } from './orphan-cleanup';
import { ORPHAN_CLEANUP_VIEW_TYPE, OrphanCleanupView } from './orphan-cleanup-view';
import { isPathInFolder, normalizeSettings } from './core-utils';

export default class RelatedOperationsPlugin extends Plugin {
	private notebookNavigatorRegistered = false;
	private linkStatsUpdaterStarted = false;
	private linkStatsUpdate?: Promise<number>;
	private linkStatsDebounceTimer = 0;
	settings!: RelatedOperationsSettings;
	async onload() {
		const propertyName = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value);
		const loaded = normalizeSettings(DEFAULT_SETTINGS, await this.loadData(), {
			incomingProperty: propertyName,
			outgoingProperty: propertyName,
			bidirectionalProperty: propertyName,
		});
		const propertyNames = [loaded.incomingProperty, loaded.outgoingProperty, loaded.bidirectionalProperty];
		if (new Set(propertyNames).size !== propertyNames.length) {
			loaded.incomingProperty = DEFAULT_SETTINGS.incomingProperty;
			loaded.outgoingProperty = DEFAULT_SETTINGS.outgoingProperty;
			loaded.bidirectionalProperty = DEFAULT_SETTINGS.bidirectionalProperty;
		}
		this.settings = loaded;
		this.registerLinkStatsUpdater();
		this.registerView(RELATED_NOTES_VIEW_TYPE, (leaf) => new RelatedNotesView(leaf, this.settings, () => this.saveSettings()));
		this.registerView(ORPHAN_CLEANUP_VIEW_TYPE, (leaf) => new OrphanCleanupView(leaf, this.settings));
		this.addSettingTab(new RelatedOperationsSettingTab(this.app, this));
		this.registerNotebookNavigatorMenus();
		this.app.workspace.onLayoutReady(() => this.retryNotebookNavigatorRegistration());
		this.addCommand({
			id: 'move-related-notes',
			name: '整理关联笔记',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const sourceFiles = this.getPreferredSourceFiles(file);
				if (sourceFiles.length === 0) return false;
				if (!checking) void this.openRelatedNotesWindow(sourceFiles);
				return true;
			},
		});
		this.addCommand({
			id: 'refresh-related-link-properties',
			name: '刷新全库笔记关系数量',
			callback: async () => {
				if (!this.settings.enabled) {
					new Notice('请先在设置中启用关联数量属性。');
					return;
				}
				const count = await this.updateAllLinkStatsOrNotice();
				if (count === null) return;
				new Notice(`已更新 ${count} 篇笔记的关联数量属性。`);
			},
		});
		this.addCommand({
			id: 'scan-and-clean-orphan-resources',
			name: '打开 vault 体检与清理',
			callback: () => void this.openOrphanCleanupWindow(),
		});

		this.addRibbonIcon('move', '整理关联笔记', () => {
			const file = this.app.workspace.getActiveFile();
			const sourceFiles = this.getPreferredSourceFiles(file);
			if (sourceFiles.length === 0) {
				new Notice('请先打开 Markdown 笔记。');
				return;
			}
			void this.openRelatedNotesWindow(sourceFiles);
		});
		this.addRibbonIcon('trash-2', '打开 vault 体检与清理', () => void this.openOrphanCleanupWindow());

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				menu.addItem((item) =>
					item
						.setTitle('打开所在文件夹')
						.setIcon('folder-open')
						.onClick(() => openInSystemFolder(this.app, file)),
				);
				const sourceFiles = this.getSourceFiles(file);
				if (sourceFiles.length === 0) return;
				menu.addItem((item) =>
					item
						.setTitle(file instanceof TFolder ? '整理文件夹内关联笔记' : '整理关联笔记')
						.setIcon('move')
						.onClick(() => void this.openRelatedNotesWindow(sourceFiles)),
				);
			}),
		);

		this.registerEvent(
			this.app.workspace.on('files-menu', (menu, files) => {
				const sourceFiles = files.flatMap((file) => this.getSourceFiles(file));
				const uniqueFiles = this.uniqueFiles(sourceFiles);
				if (uniqueFiles.length < 2) return;
				menu.addItem((item) =>
					item
						.setTitle('整理多个笔记的关联笔记')
						.setIcon('move')
						.onClick(() => void this.openRelatedNotesWindow(uniqueFiles)),
				);
			}),
		);
	}

	private async openRelatedNotesWindow(sourceFiles: TFile[]) {
		const orderedFiles = this.uniqueFiles(sourceFiles).sort((a, b) => a.path.localeCompare(b.path));
		if (orderedFiles.length === 0) {
			new Notice('没有可处理的 Markdown 笔记。');
			return;
		}
		const primarySource = orderedFiles.at(0);
		if (!primarySource) return;
		if (orderedFiles.some((file) => !this.app.metadataCache.getFileCache(file))) {
			new Notice('正在解析关联笔记…');
			await this.waitForMetadataResolution();
		}
		const relatedNotes = getRelatedNotesForFiles(this.app, orderedFiles);
		const sourceLabel = orderedFiles.length === 1 ? primarySource.basename : `${orderedFiles.length} 篇源笔记`;
		if (Platform.isMobile) {
			new RelatedNotesModal(this.app, primarySource, orderedFiles, relatedNotes, sourceLabel, orderedFiles.length, this.settings, () => this.saveSettings()).open();
			return;
		}
		const existingLeaf = this.app.workspace.getLeavesOfType(RELATED_NOTES_VIEW_TYPE).at(0);
		if (existingLeaf) {
			await existingLeaf.setViewState({
				type: RELATED_NOTES_VIEW_TYPE,
				active: true,
				state: { sourcePaths: orderedFiles.map((file) => file.path) },
			});
			await this.app.workspace.revealLeaf(existingLeaf);
			return;
		}
		try {
			const leaf = this.app.workspace.openPopoutLeaf();
			await leaf.setViewState({
				type: RELATED_NOTES_VIEW_TYPE,
				active: true,
				state: { sourcePaths: orderedFiles.map((file) => file.path) },
			});
		} catch {
			new RelatedNotesModal(this.app, primarySource, orderedFiles, relatedNotes, sourceLabel, orderedFiles.length, this.settings, () => this.saveSettings()).open();
		}
	}

	private async openOrphanCleanupWindow() {
		if (Platform.isMobile) {
			new OrphanCleanupModal(this.app, this.settings).open();
			return;
		}
		const existingLeaf = this.app.workspace.getLeavesOfType(ORPHAN_CLEANUP_VIEW_TYPE).at(0);
		if (existingLeaf) {
			await this.app.workspace.revealLeaf(existingLeaf);
			return;
		}
		try {
			const leaf = this.app.workspace.openPopoutLeaf();
			await leaf.setViewState({
				type: ORPHAN_CLEANUP_VIEW_TYPE,
				active: true,
			});
		} catch {
			new OrphanCleanupModal(this.app, this.settings).open();
		}
	}

	private async waitForMetadataResolution() {
		await new Promise<void>((resolve) => {
			let settled = false;
			let timeout = 0;
			const finish = () => {
				if (settled) return;
				settled = true;
				this.app.metadataCache.offref(ref);
				window.clearTimeout(timeout);
				resolve();
			};
			const ref = this.app.metadataCache.on('resolved', () => {
				finish();
			});
			timeout = window.setTimeout(finish, 2000);
		});
	}

	private getSourceFiles(file: TAbstractFile): TFile[] {
		if (file instanceof TFile && file.extension.toLowerCase() === 'md') return [file];
		if (file instanceof TFolder) {
			return this.app.vault
				.getMarkdownFiles()
				.filter((candidate) => isPathInFolder(candidate.path, file.path));
		}
		return [];
	}

	private getPreferredSourceFiles(activeFile: TFile | null): TFile[] {
		const api = this.getNotebookNavigatorApi();
		const selected = api?.selection.getCurrent().files ?? [];
		const selectedFiles = this.uniqueFiles([...selected]).filter((file) => file.extension.toLowerCase() === 'md');
		if (selectedFiles.length > 0) return selectedFiles;
		return activeFile && activeFile.extension.toLowerCase() === 'md' ? [activeFile] : [];
	}

	private uniqueFiles(files: TFile[]): TFile[] {
		return [...new Map(files.map((file) => [file.path, file])).values()];
	}

	private registerNotebookNavigatorMenus() {
		if (this.notebookNavigatorRegistered) return;
		const api = this.getNotebookNavigatorApi();
		if (!api) return;
		this.notebookNavigatorRegistered = true;

		const disposeFileMenu = api.menus.registerFileMenu((context) => {
			const sourceFiles = this.uniqueFiles([...context.selection.files]);
			if (sourceFiles.length === 0) return;
			context.addItem((item) =>
				item
					.setTitle(sourceFiles.length > 1 ? '整理多个笔记的关联笔记' : '整理关联笔记')
					.setIcon('move')
					.onClick(() => void this.openRelatedNotesWindow(sourceFiles)),
			);
		});
		const disposeFolderMenu = api.menus.registerFolderMenu((context) => {
			const sourceFiles = this.getSourceFiles(context.folder);
			if (sourceFiles.length === 0) return;
			context.addItem((item) =>
				item
					.setTitle('整理文件夹内关联笔记')
					.setIcon('move')
					.onClick(() => void this.openRelatedNotesWindow(sourceFiles)),
			);
		});

		this.register(() => {
			disposeFileMenu();
			disposeFolderMenu();
		});
	}

	private retryNotebookNavigatorRegistration() {
		let attempts = 0;
		let timeout = 0;
		const attempt = () => {
			if (this.notebookNavigatorRegistered || attempts++ >= 10) return;
			this.registerNotebookNavigatorMenus();
			if (!this.notebookNavigatorRegistered) timeout = window.setTimeout(attempt, 500);
		};
		this.register(() => {
			if (timeout) window.clearTimeout(timeout);
		});
		attempt();
	}

	private getNotebookNavigatorApi(): NotebookNavigatorApi | undefined {
		const plugins = (this.app as unknown as { plugins?: {
			plugins?: Record<string, { api?: NotebookNavigatorApi }>;
		} }).plugins;
		return plugins?.plugins?.['notebook-navigator']?.api;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async applyLinkStatsPropertyNames(nextNames: LinkStatsPropertyNames): Promise<{ migrated: number; updated: number; conflicts: Array<{ path: string; property: string }> }> {
		const oldNames: LinkStatsPropertyNames = {
			incomingProperty: this.settings.incomingProperty,
			outgoingProperty: this.settings.outgoingProperty,
			bidirectionalProperty: this.settings.bidirectionalProperty,
		};
		const files = this.app.vault.getMarkdownFiles();
		const conflicts = findLinkStatsPropertyConflicts(this.app, files, oldNames, nextNames);
		if (conflicts.length) return { migrated: 0, updated: 0, conflicts };
		const migrated = await migrateLinkStatsProperties(this.app, files, oldNames, nextNames);
		Object.assign(this.settings, nextNames);
		await this.saveSettings();
		const updated = this.settings.enabled ? await this.updateAllLinkStats(true) : 0;
		return { migrated, updated, conflicts: [] };
	}

	private registerLinkStatsUpdater() {
		if (this.linkStatsUpdaterStarted) return;
		this.linkStatsUpdaterStarted = true;
		const schedule = () => {
			if (!this.settings.enabled || !this.settings.autoUpdate) return;
			window.clearTimeout(this.linkStatsDebounceTimer);
			this.linkStatsDebounceTimer = window.setTimeout(() => {
				this.linkStatsDebounceTimer = 0;
				if (this.settings.enabled && this.settings.autoUpdate) void this.updateAllLinkStatsOrNotice();
			}, 800);
		};
		const scheduleForLinkRelevantChange = (file: TAbstractFile) => {
			if (file instanceof TFolder || (file instanceof TFile && file.extension.toLowerCase() === 'md')) schedule();
		};
		this.registerEvent(this.app.vault.on('modify', (file) => {
			scheduleForLinkRelevantChange(file);
		}));
		this.registerEvent(this.app.vault.on('create', scheduleForLinkRelevantChange));
		this.registerEvent(this.app.vault.on('delete', scheduleForLinkRelevantChange));
		this.registerEvent(this.app.vault.on('rename', scheduleForLinkRelevantChange));
		this.registerInterval(window.setInterval(() => {
			if (this.settings.enabled && this.settings.autoUpdate) void this.updateAllLinkStatsOrNotice();
		}, 60_000));
		this.register(() => window.clearTimeout(this.linkStatsDebounceTimer));
		if (this.settings.enabled) void this.updateAllLinkStatsOrNotice();
	}

	refreshLinkStatsUpdater() {
		this.registerLinkStatsUpdater();
		if (this.settings.enabled) void this.updateAllLinkStatsOrNotice();
	}

	cancelPendingLinkStatsUpdate() {
		window.clearTimeout(this.linkStatsDebounceTimer);
		this.linkStatsDebounceTimer = 0;
	}

	private async updateAllLinkStats(force = false) {
		if (!this.settings.enabled) return 0;
		if (this.linkStatsUpdate) {
			if (!force) return this.linkStatsUpdate;
			await this.linkStatsUpdate;
		}
		const settings = { ...this.settings };
		this.linkStatsUpdate = updateLinkStats(this.app, this.app.vault.getMarkdownFiles(), settings)
			.finally(() => { this.linkStatsUpdate = undefined; });
		return this.linkStatsUpdate;
	}

	private async updateAllLinkStatsOrNotice(): Promise<number | null> {
		try {
			return await this.updateAllLinkStats();
		} catch (error) {
			new Notice(`更新关联数量失败：${error instanceof Error ? error.message : '未知错误'}`);
			return null;
		}
	}
}

function openInSystemFolder(app: Plugin['app'], item: TAbstractFile) {
	if (!Platform.isDesktopApp || !(app.vault.adapter instanceof FileSystemAdapter)) {
		new Notice('仅桌面端的本地资料库支持打开所在文件夹。');
		return;
	}
	const electron = (window as Window & {
		require?: (module: string) => { shell?: { showItemInFolder(path: string): void; openPath?: (path: string) => Promise<string> } };
	}).require?.('electron');
	if (!electron?.shell) {
		new Notice('当前环境无法打开系统文件夹。');
		return;
	}
	const path = `${app.vault.adapter.getBasePath()}/${item.path}`;
	if (item instanceof TFolder && electron.shell.openPath) void electron.shell.openPath(path).then((error) => { if (error) new Notice('打开文件夹失败。'); }, () => new Notice('打开文件夹失败。'));
	else {
		try { electron.shell.showItemInFolder(path); } catch { new Notice('打开文件夹失败。'); }
	}
}
