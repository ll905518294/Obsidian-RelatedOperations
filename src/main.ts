import { Notice, Platform, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';
import { RelatedNotesModal } from './related-notes-modal';
import { getRelatedNotesForFiles } from './related-notes';
import { RELATED_NOTES_VIEW_TYPE, RelatedNotesView } from './related-notes-view';
import { NotebookNavigatorApi } from './notebook-navigator-api';
import { DEFAULT_SETTINGS, RelatedOperationsSettingTab, RelatedOperationsSettings } from './settings';

export default class RelatedOperationsPlugin extends Plugin {
	private notebookNavigatorRegistered = false;
	settings!: RelatedOperationsSettings;
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<RelatedOperationsSettings>);
		this.registerView(RELATED_NOTES_VIEW_TYPE, (leaf) => new RelatedNotesView(leaf, this.settings, () => this.saveSettings()));
		this.addSettingTab(new RelatedOperationsSettingTab(this.app, this));
		this.registerNotebookNavigatorMenus();
		this.app.workspace.onLayoutReady(() => this.retryNotebookNavigatorRegistration());
		this.addCommand({
			id: 'move-related-notes',
			name: '移动关联笔记',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const sourceFiles = this.getPreferredSourceFiles(file);
				if (sourceFiles.length === 0) return false;
				if (!checking) void this.openRelatedNotesWindow(sourceFiles);
				return true;
			},
		});

		this.addRibbonIcon('move', '移动关联笔记', () => {
			const file = this.app.workspace.getActiveFile();
			const sourceFiles = this.getPreferredSourceFiles(file);
			if (sourceFiles.length === 0) {
				new Notice('请先打开 Markdown 笔记。');
				return;
			}
			void this.openRelatedNotesWindow(sourceFiles);
		});

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				const sourceFiles = this.getSourceFiles(file);
				if (sourceFiles.length === 0) return;
				menu.addItem((item) =>
					item
						.setTitle(file instanceof TFolder ? '移动文件夹内关联笔记' : '移动关联笔记')
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
						.setTitle('移动多个笔记的关联笔记')
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

	private async waitForMetadataResolution() {
		await new Promise<void>((resolve) => {
			let settled = false;
			const ref = this.app.metadataCache.on('resolved', () => {
				if (settled) return;
				settled = true;
				this.app.metadataCache.offref(ref);
				resolve();
			});
			window.setTimeout(() => {
				if (settled) return;
				settled = true;
				this.app.metadataCache.offref(ref);
				resolve();
			}, 2000);
		});
	}

	private getSourceFiles(file: TAbstractFile): TFile[] {
		if (file instanceof TFile && file.extension.toLowerCase() === 'md') return [file];
		if (file instanceof TFolder) {
			return this.app.vault
				.getMarkdownFiles()
				.filter((candidate) => candidate.path.startsWith(`${file.path}/`));
		}
		return [];
	}

	private getPreferredSourceFiles(activeFile: TFile | null): TFile[] {
		const api = this.getNotebookNavigatorApi();
		const selected = api?.selection.getCurrent().files ?? [];
		const selectedFiles = this.uniqueFiles([...selected]).filter((file) => file.extension.toLowerCase() === 'md');
		if (selectedFiles.length > 1) return selectedFiles;
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
					.setTitle(sourceFiles.length > 1 ? '移动多个笔记的关联笔记' : '移动关联笔记')
					.setIcon('move')
					.onClick(() => void this.openRelatedNotesWindow(sourceFiles)),
			);
		});
		const disposeFolderMenu = api.menus.registerFolderMenu((context) => {
			const sourceFiles = this.getSourceFiles(context.folder);
			if (sourceFiles.length === 0) return;
			context.addItem((item) =>
				item
					.setTitle('移动文件夹内关联笔记')
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
