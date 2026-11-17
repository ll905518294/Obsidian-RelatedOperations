import { Notice, Platform, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';
import { RelatedNotesModal } from './related-notes-modal';
import { getRelatedNotesForFiles } from './related-notes';
import { RELATED_NOTES_VIEW_TYPE, RelatedNotesView } from './related-notes-view';
import { NotebookNavigatorApi } from './notebook-navigator-api';
import { DEFAULT_SETTINGS, RelatedOperationsSettingTab, RelatedOperationsSettings } from './settings';
import { OrphanCleanupModal } from './orphan-cleanup';
import { ORPHAN_CLEANUP_VIEW_TYPE, OrphanCleanupView } from './orphan-cleanup-view';
import { openInSystemFolder } from './cleanup/cleanup-actions';
import { groupingModeFromLegacy, isPathInFolder, normalizeSettings } from './core-utils';
import { currentUpdateIntro, shouldShowIntro } from './update-intro-content';
import { UpdateIntroModal } from './update-intro';
import { decideStartupIntro } from './onboarding-content';
import { OnboardingModal, type OnboardingAction } from './onboarding';
import { normalizeImageConversionConfig } from './cleanup/cleanup-types';

export default class RelatedOperationsPlugin extends Plugin {
	private notebookNavigatorRegistered = false;
	// 体检页签成为活动视图后 getActiveFile() 会返回 null；记住打开面板前的
	// 最近一篇 Markdown 笔记，首页入口卡才能以它为源继续整理。
	private lastActiveMarkdownPath?: string;
	settings!: RelatedOperationsSettings;
	async onload() {
		const rawSettings: unknown = await this.loadData();
		const loaded = normalizeSettings(DEFAULT_SETTINGS, rawSettings);
		// Older data.json files predate image conversion; normalize the nested
		// object without dropping any unrelated setting.
		loaded.imageConversion = normalizeImageConversionConfig(loaded.imageConversion);
		if (rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)) {
			const persisted = rawSettings as Record<string, unknown>;
			const legacy = persisted as { groupBySource?: unknown; groupByPath?: unknown };
			const groupingModeMigrated = typeof persisted.groupingMode !== 'string' && (typeof legacy.groupBySource === 'boolean' || typeof legacy.groupByPath === 'boolean');
			if (groupingModeMigrated) {
				loaded.groupingMode = groupingModeFromLegacy(legacy);
			}
			// Retired link-count fields (enabled/autoUpdate/property names) are
			// dropped from data.json on the first load after upgrading.
			const retiredFieldsSaved = ['enabled', 'autoUpdate', 'incomingProperty', 'outgoingProperty', 'bidirectionalProperty']
				.some((key) => key in persisted);
			const conversionNeedsSave = JSON.stringify(persisted.imageConversion) !== JSON.stringify(loaded.imageConversion);
			if (groupingModeMigrated || retiredFieldsSaved || conversionNeedsSave) {
				await this.saveData(loaded);
			}
		}
		this.settings = loaded;
		this.registerView(RELATED_NOTES_VIEW_TYPE, (leaf) => new RelatedNotesView(leaf, this.settings, () => this.saveSettings()));
		this.registerView(ORPHAN_CLEANUP_VIEW_TYPE, (leaf) => new OrphanCleanupView(leaf, this.settings, () => this.saveSettings(), () => this.openRelatedNotesFromCurrent()));
		this.addSettingTab(new RelatedOperationsSettingTab(this.app, this));
		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if (file && file.extension.toLowerCase() === 'md') this.lastActiveMarkdownPath = file.path;
		}));
		this.registerNotebookNavigatorMenus();
		this.app.workspace.onLayoutReady(() => this.retryNotebookNavigatorRegistration());
		this.app.workspace.onLayoutReady(() => void this.maybeShowStartupIntro());
		this.addCommand({
			id: 'move-related-notes',
			name: '整理关联笔记',
			// 唯一入口改为体检与清理视图；关联笔记整理是首页内的功能卡。
			callback: () => void this.openOrphanCleanupWindow(),
		});
		this.addCommand({
			id: 'scan-and-clean-orphan-resources',
			name: '打开 vault 体检与清理',
			callback: () => void this.openOrphanCleanupWindow(),
		});
		this.addCommand({
			id: 'open-update-intro',
			name: '查看更新说明',
			callback: () => this.openUpdateIntro(),
		});
		this.addCommand({
			id: 'open-onboarding',
			name: '打开使用引导',
			callback: () => this.openOnboarding(),
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

	private openUpdateIntro() {
		const version = this.manifest.version;
		const intro = currentUpdateIntro(version);
		if (!intro) {
			new Notice(`当前版本 ${version} 暂无内置更新说明。`);
			return;
		}
		new UpdateIntroModal(this.app, this.manifest.name, intro).open();
	}

	private openOnboarding() {
		new OnboardingModal(this.app, { name: this.manifest.name, version: this.manifest.version }, (action) => this.finishOnboarding(action)).open();
	}

	private finishOnboarding(action: OnboardingAction) {
		if (action === 'cleanup') void this.openOrphanCleanupWindow();
	}

	private async maybeShowStartupIntro() {
		const version = this.manifest.version;
		const decision = decideStartupIntro(version, this.settings.lastSeenVersion, this.settings.onboardingSeen);
		if (decision === 'onboarding') {
			// Mark both flags up front so a reload cannot show it twice and the
			// update intro stays silent for this same version.
			this.settings.onboardingSeen = true;
			this.settings.lastSeenVersion = version;
			new OnboardingModal(this.app, { name: this.manifest.name, version: this.manifest.version }, (action) => this.finishOnboarding(action)).open();
			await this.saveSettings();
			return;
		}
		if (decision === 'update') await this.maybeShowUpdateIntro();
	}

	private async maybeShowUpdateIntro() {
		const version = this.manifest.version;
		if (!shouldShowIntro(version, this.settings.lastSeenVersion)) return;
		const intro = currentUpdateIntro(version);
		if (!intro) return;
		new UpdateIntroModal(this.app, this.manifest.name, intro).open();
		this.settings.lastSeenVersion = version;
		await this.saveSettings();
	}

	private openRelatedNotesFromCurrent() {
		const active = this.app.workspace.getActiveFile();
		const fallback = this.lastActiveMarkdownPath
			? this.app.vault.getAbstractFileByPath(this.lastActiveMarkdownPath)
			: null;
		const sourceFile = active instanceof TFile && active.extension.toLowerCase() === 'md'
			? active
			: fallback instanceof TFile && fallback.extension.toLowerCase() === 'md'
				? fallback
				: null;
		const sourceFiles = this.getPreferredSourceFiles(sourceFile);
		if (sourceFiles.length === 0) {
			new Notice('请先打开 Markdown 笔记。');
			return;
		}
		void this.openRelatedNotesWindow(sourceFiles);
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
		const openFallbackModal = () => new RelatedNotesModal(this.app, primarySource, orderedFiles, relatedNotes, sourceLabel, orderedFiles.length, this.settings, () => this.saveSettings()).open();
		if (Platform.isMobile) {
			openFallbackModal();
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
			openFallbackModal();
		}
	}

	private async openOrphanCleanupWindow() {
		const active = this.app.workspace.getActiveFile();
		if (active instanceof TFile && active.extension.toLowerCase() === 'md') {
			this.lastActiveMarkdownPath = active.path;
		}
		const openFallbackModal = () => new OrphanCleanupModal(this.app, this.settings, async (cache) => {
			this.settings.orphanCleanupCache = cache;
			await this.saveSettings();
		}, () => this.saveSettings(), () => this.openRelatedNotesFromCurrent()).open();
		if (Platform.isMobile) {
			openFallbackModal();
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
			openFallbackModal();
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
}

