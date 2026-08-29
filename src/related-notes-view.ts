import { ItemView, TFile, TFolder } from 'obsidian';
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
		return '关联笔记整理';
	}

	getIcon() {
		return 'move';
	}

	async setState(state: unknown, result: { history: boolean }) {
		const nextState = state && typeof state === 'object' ? state as { sourcePath?: unknown; sourcePaths?: unknown } : {};
		const paths = Array.isArray(nextState.sourcePaths)
			? nextState.sourcePaths.filter((path): path is string => typeof path === 'string' && path.length > 0)
			: typeof nextState.sourcePath === 'string' && nextState.sourcePath.length > 0
				? [nextState.sourcePath]
				: this.sourcePaths;
		this.sourcePaths = [...new Set(paths)];
		await super.setState(state, result);
		this.renderPanel();
	}

	getState() {
		return { sourcePaths: this.sourcePaths };
	}

	async onOpen() {
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			let changed = false;
			this.sourcePaths = this.sourcePaths.map((path) => {
				if (path === oldPath) { changed = true; return file.path; }
				if (file instanceof TFolder && path.startsWith(`${oldPath}/`)) {
					changed = true;
					return `${file.path}${path.slice(oldPath.length)}`;
				}
				return path;
			});
			if (!changed) return;
			this.renderPanel();
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			const previousLength = this.sourcePaths.length;
			this.sourcePaths = this.sourcePaths.filter((path) => path !== file.path && !(file instanceof TFolder && path.startsWith(`${file.path}/`)));
			if (this.sourcePaths.length === previousLength) return;
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
		this.panel = undefined;
		this.contentEl.empty();
		const sourceFiles = this.sourcePaths
			.map((path) => this.app.vault.getAbstractFileByPath(path))
			.filter((file): file is TFile => file instanceof TFile && file.extension.toLowerCase() === 'md')
			.sort((a, b) => a.path.localeCompare(b.path));
		const sourceFile = sourceFiles[0];
		if (!sourceFile) {
			void this.leaf.detach();
			return;
		}
		const related = getRelatedNotesForFiles(this.app, sourceFiles);
		const sourceLabel = sourceFiles.length === 1 ? sourceFile.basename : `${sourceFiles.length} 篇源笔记`;
		this.panel = new RelatedNotesPanel(this.app, this.contentEl, sourceFile, sourceFiles, related, {
			close: () => this.leaf.detach(),
		}, sourceLabel, sourceFiles.length, this.settings, this.saveSettings);
		this.panel.render();
	}
}
