import { ItemView, TFile } from 'obsidian';
import { getRelatedNotesForFiles } from './related-notes';
import { RelatedNotesPanel } from './related-notes-modal';
import { RelatedOperationsSettings } from './settings';

export const RELATED_NOTES_VIEW_TYPE = 'related-operations-view';

export class RelatedNotesView extends ItemView {
	private sourcePaths: string[] = [];
	private panel?: RelatedNotesPanel;

	constructor(
		leaf: import('obsidian').WorkspaceLeaf,
		private readonly settings: RelatedOperationsSettings,
		private readonly saveSettings: () => Promise<void>,
	) {
		super(leaf);
	}

	getViewType() {
		return RELATED_NOTES_VIEW_TYPE;
	}

	getDisplayText() {
		return '移动关联笔记';
	}

	getIcon() {
		return 'move';
	}

	async setState(state: unknown, result: { history: boolean }) {
		const nextState = state as { sourcePath?: string; sourcePaths?: string[] };
		this.sourcePaths = nextState.sourcePaths ?? (nextState.sourcePath ? [nextState.sourcePath] : this.sourcePaths);
		await super.setState(state, result);
		this.renderPanel();
	}

	getState() {
		return { sourcePaths: this.sourcePaths };
	}

	async onOpen() {
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			const index = this.sourcePaths.indexOf(oldPath);
			if (index < 0) return;
			this.sourcePaths[index] = file.path;
			this.renderPanel();
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (!this.sourcePaths.includes(file.path)) return;
			this.sourcePaths = this.sourcePaths.filter((path) => path !== file.path);
			if (this.sourcePaths.length === 0) this.leaf.detach();
			else this.renderPanel();
		}));
		this.renderPanel();
	}

	async onClose() {
		this.panel = undefined;
		this.contentEl.empty();
	}

	private renderPanel() {
		const sourceFiles = this.sourcePaths
			.map((path) => this.app.vault.getAbstractFileByPath(path))
			.filter((file): file is TFile => file instanceof TFile && file.extension === 'md')
			.sort((a, b) => a.path.localeCompare(b.path));
		const sourceFile = sourceFiles[0];
		if (!sourceFile) return;
		const related = getRelatedNotesForFiles(this.app, sourceFiles);
		const sourceLabel = sourceFiles.length === 1 ? sourceFile.basename : `${sourceFiles.length} 篇源笔记`;
		this.panel = new RelatedNotesPanel(this.app, this.contentEl, sourceFile, sourceFiles, related, {
			close: () => this.leaf.detach(),
		}, sourceLabel, sourceFiles.length, this.settings, this.saveSettings);
		this.panel.render();
	}
}
