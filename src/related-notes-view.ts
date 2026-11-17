import { ItemView, TFile, TFolder } from 'obsidian';
import { getRelatedNotesForFiles } from './related-notes';
import { RelatedNotesPanel } from './related-notes-modal';
import { RelatedOperationsSettings } from './settings';
import type { MoveRecord } from './related-notes/related-notes-model';

export const RELATED_NOTES_VIEW_TYPE = 'related-operations-view';

export class RelatedNotesView extends ItemView {
	private sourcePaths: string[] = [];
	private mergeTargetView = false;
	// Undo belongs to the open view, not to one source note: switching sources
	// recreates the panel, but the moves made in this view must stay undoable.
	private lastMove: MoveRecord[] = [];
	private panel?: RelatedNotesPanel;
	private refreshTimer?: number;

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
		const nextState = state && typeof state === 'object' ? state as { sourcePath?: unknown; sourcePaths?: unknown; mergeTargetView?: unknown } : {};
		const paths = Array.isArray(nextState.sourcePaths)
			? nextState.sourcePaths.filter((path): path is string => typeof path === 'string' && path.length > 0)
			: typeof nextState.sourcePath === 'string' && nextState.sourcePath.length > 0
				? [nextState.sourcePath]
				: this.sourcePaths;
		this.sourcePaths = [...new Set(paths)];
		if (typeof nextState.mergeTargetView === 'boolean') this.mergeTargetView = nextState.mergeTargetView;
		await super.setState(state, result);
		this.renderPanel();
	}

	getState() {
		return { sourcePaths: this.sourcePaths, mergeTargetView: this.mergeTargetView };
	}

	async onOpen() {
		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			if (this.isRelevantChange(file.path)) this.scheduleRefresh();
		}));
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
			if (!changed) {
				if (this.panel?.hasRelatedPath(oldPath)) this.scheduleRefresh();
				return;
			}
			this.renderPanel();
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			const previousLength = this.sourcePaths.length;
			this.sourcePaths = this.sourcePaths.filter((path) => path !== file.path && !(file instanceof TFolder && path.startsWith(`${file.path}/`)));
			if (this.sourcePaths.length === previousLength) {
				if (this.panel?.hasRelatedPath(file.path)) this.scheduleRefresh();
				return;
			}
			this.renderPanel();
		}));
		this.renderPanel();
	}

	async onClose() {
		if (this.refreshTimer !== undefined) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.panel = undefined;
		this.contentEl.empty();
	}

	private scheduleRefresh() {
		if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = undefined;
			this.panel?.refreshRelations();
		}, 400);
	}

	private isRelevantChange(path: string) {
		if (this.sourcePaths.includes(path)) return true;
		if (this.panel?.hasRelatedPath(path)) return true;
		const destinations = this.app.metadataCache.resolvedLinks[path];
		return destinations ? Object.keys(destinations).some((target) => this.sourcePaths.includes(target)) : false;
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
			this.contentEl.createEl('p', { text: '请先打开或选择 Markdown 笔记，再使用关联笔记整理。', cls: 'related-operations-empty' });
			return;
		}
		const related = getRelatedNotesForFiles(this.app, sourceFiles);
		const sourceLabel = sourceFiles.length === 1 ? sourceFile.basename : `${sourceFiles.length} 篇源笔记`;
		this.panel = new RelatedNotesPanel(this.app, this.contentEl, sourceFile, sourceFiles, related, {
			close: () => this.leaf.detach(),
		}, sourceLabel, sourceFiles.length, this.settings, this.saveSettings, this.mergeTargetView, (merging) => {
			this.mergeTargetView = merging;
			void this.app.workspace.requestSaveLayout();
		}, this.lastMove, (records) => { this.lastMove = records; });
		this.panel.render();
	}
}
