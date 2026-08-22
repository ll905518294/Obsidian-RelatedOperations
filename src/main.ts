import { Notice, Platform, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { RelatedNotesModal } from './related-notes-modal';
import { getRelatedNotesForFiles } from './related-notes';
import { RELATED_NOTES_VIEW_TYPE, RelatedNotesView } from './related-notes-view';

export default class RelatedOperationsPlugin extends Plugin {
	private relatedLeaf?: WorkspaceLeaf;

	async onload() {
		this.registerView(RELATED_NOTES_VIEW_TYPE, (leaf) => new RelatedNotesView(leaf));
		this.addCommand({
			id: 'move-related-notes',
			name: '移动关联笔记',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				if (!checking) void this.openRelatedNotesWindow([file]);
				return true;
			},
		});

		this.addRibbonIcon('move', '移动关联笔记', () => {
			const file = this.app.workspace.getActiveFile();
			if (!file || file.extension !== 'md') {
				new Notice('请先打开 Markdown 笔记。');
				return;
			}
			void this.openRelatedNotesWindow([file]);
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
			new RelatedNotesModal(this.app, primarySource, relatedNotes, sourceLabel, orderedFiles.length).open();
			return;
		}
		try {
			const leaf = this.relatedLeaf ?? this.app.workspace.openPopoutLeaf();
			this.relatedLeaf = leaf;
			await leaf.setViewState({
				type: RELATED_NOTES_VIEW_TYPE,
				active: true,
				state: { sourcePaths: orderedFiles.map((file) => file.path) },
			});
		} catch {
			this.relatedLeaf = undefined;
			new RelatedNotesModal(this.app, primarySource, relatedNotes, sourceLabel, orderedFiles.length).open();
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

	private uniqueFiles(files: TFile[]): TFile[] {
		return [...new Map(files.map((file) => [file.path, file])).values()];
	}
}
