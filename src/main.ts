import { FileSystemAdapter, Notice, Platform, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';
import { RelatedNotesModal } from './related-notes-modal';
import { getRelatedNotesForFiles } from './related-notes';
import { RELATED_NOTES_VIEW_TYPE, RelatedNotesView } from './related-notes-view';
import { NotebookNavigatorApi } from './notebook-navigator-api';
import { DEFAULT_SETTINGS, RelatedOperationsSettingTab, RelatedOperationsSettings } from './settings';
import { collectLinkStatsPropertyEntries, removeLinkStatsPropertyEntries, HISTORICAL_LINK_STATS_PROPERTY_NAMES } from './link-stats-cleanup';
import { confirmLinkStatsCleanup } from './link-stats-cleanup-modal';
import { OrphanCleanupModal } from './orphan-cleanup';
import { ORPHAN_CLEANUP_VIEW_TYPE, OrphanCleanupView } from './orphan-cleanup-view';
import { groupingModeFromLegacy, isPathInFolder, normalizeSettings } from './core-utils';

export default class RelatedOperationsPlugin extends Plugin {
	private notebookNavigatorRegistered = false;
	settings!: RelatedOperationsSettings;
	async onload() {
		const propertyName = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value);
		const rawSettings: unknown = await this.loadData();
		const loaded = normalizeSettings(DEFAULT_SETTINGS, rawSettings, {
			incomingProperty: propertyName,
			outgoingProperty: propertyName,
			bidirectionalProperty: propertyName,
		});
		if (rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)) {
			const legacy = rawSettings as { groupBySource?: unknown; groupByPath?: unknown };
			if (typeof (rawSettings as { groupingMode?: unknown }).groupingMode !== 'string' && (typeof legacy.groupBySource === 'boolean' || typeof legacy.groupByPath === 'boolean')) {
				loaded.groupingMode = groupingModeFromLegacy(legacy);
				await this.saveData(loaded);
			}
		}
		const propertyNames = [loaded.incomingProperty, loaded.outgoingProperty, loaded.bidirectionalProperty];
		if (new Set(propertyNames).size !== propertyNames.length) {
			loaded.incomingProperty = DEFAULT_SETTINGS.incomingProperty;
			loaded.outgoingProperty = DEFAULT_SETTINGS.outgoingProperty;
			loaded.bidirectionalProperty = DEFAULT_SETTINGS.bidirectionalProperty;
		}
		this.settings = loaded;
		this.registerView(RELATED_NOTES_VIEW_TYPE, (leaf) => new RelatedNotesView(leaf, this.settings, () => this.saveSettings()));
		this.registerView(ORPHAN_CLEANUP_VIEW_TYPE, (leaf) => new OrphanCleanupView(leaf, this.settings, () => this.saveSettings()));
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
			id: 'remove-link-stats-properties',
			name: '清除关联数量属性',
			callback: () => void this.removeLinkStatsProperties(),
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
		this.addRibbonIcon('plus-square', '打开 vault 体检与清理', () => void this.openOrphanCleanupWindow());

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
		const primarySource = orderedFiles[0]!;
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
		const existingLeaf = this.app.workspace.getLeavesOfType(RELATED_NOTES_VIEW_TYPE)[0]!;
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
			const leaf = this.app.workspace.getLeaf('tab');
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
			new OrphanCleanupModal(this.app, this.settings, async (cache) => {
				this.settings.orphanCleanupCache = cache;
				await this.saveSettings();
			}).open();
			return;
		}
		const existingLeaf = this.app.workspace.getLeavesOfType(ORPHAN_CLEANUP_VIEW_TYPE)[0];
		if (existingLeaf) {
			await this.app.workspace.revealLeaf(existingLeaf);
			return;
		}
		try {
			const leaf = this.app.workspace.getLeaf('tab');
			await leaf.setViewState({
				type: ORPHAN_CLEANUP_VIEW_TYPE,
				active: true,
			});
		} catch {
			new OrphanCleanupModal(this.app, this.settings, async (cache) => {
				this.settings.orphanCleanupCache = cache;
				await this.saveSettings();
			}).open();
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

	private async removeLinkStatsProperties(): Promise<void> {
		const names = this.linkStatsCleanupNames();
		const files = this.app.vault.getMarkdownFiles();
		const entries = collectLinkStatsPropertyEntries(
			files.map((file) => ({
				path: file.path,
				frontmatter: this.app.metadataCache.getFileCache(file)?.frontmatter,
			})),
			names,
		);
		if (entries.length === 0) {
			new Notice('未发现关联数量属性');
			return;
		}
		const propertyCount = entries.reduce((sum, entry) => sum + entry.matchedKeys.length, 0);
		const samplePaths = entries.slice(0, 3).map((entry) => entry.path);
		if (!(await confirmLinkStatsCleanup(this.app, entries.length, propertyCount, samplePaths))) return;

		let fileByPath: Map<string, TFile>;
		try {
			fileByPath = new Map(this.app.vault.getMarkdownFiles().map((file) => [file.path, file]));
		} catch (error) {
			new Notice(`读取笔记失败：${error instanceof Error ? error.message : '未知错误'}`);
			return;
		}
		const summary = await removeLinkStatsPropertyEntries(entries, async (path, keys) => {
			const file = fileByPath.get(path);
			if (!file) throw new Error('文件不存在或已被移除');
			await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				for (const key of keys) delete frontmatter[key];
			});
		});
		const failureSample = summary.failed.slice(0, 3).map((item) => `${item.path}（${item.reason}）`).join('、');
		const failureSuffix = failureSample ? `：${failureSample}` : '';
		new Notice(`清理 ${summary.cleaned} 篇 / 跳过 ${summary.skipped} 篇 / 失败 ${summary.failed.length} 篇${failureSuffix}`);
	}

	// Current configured names plus the historical defaults, deduplicated and
	// filtered, so a one-time cleanup can find properties from any past release.
	private linkStatsCleanupNames(): string[] {
		return [...new Set([
			this.settings.incomingProperty,
			this.settings.outgoingProperty,
			this.settings.bidirectionalProperty,
			...Object.values(HISTORICAL_LINK_STATS_PROPERTY_NAMES),
		])].filter((name) => typeof name === 'string' && name.trim().length > 0);
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
