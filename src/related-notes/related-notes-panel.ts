import { App, TFile } from 'obsidian';
import { defaultTargetFolder, getRelatedNotesForFiles, type RelatedNote } from '../related-notes';
import { DEFAULT_SETTINGS, type RelatedOperationsSettings } from '../settings';
import { joinVaultPath } from '../core-utils';
import { addFolderInput } from './related-notes-folder-input';
import {
	buildRelatedGroups,
	isAlreadyAtTarget,
	parentFolder,
	uniqueCount,
	type GroupingMode,
	type MoveRecord,
	type RelatedGroups,
	type RelationGroup,
} from './related-notes-model';
import { moveFiles as moveFilesWithHost, moveSelected as moveSelectedWithHost, undoLastMove as undoLastMoveWithHost, type RelatedNotesMoveHost } from './related-notes-move';
import { renderList, syncRowCheckboxes, updatePreviews, updateSelectAllState, updateSelectionSummary } from './related-notes-list';
import type { RelatedNotesListHost } from './related-notes-list-host';

export interface RelatedNotesHost {
	close(): void;
}

export class RelatedNotesPanel {
	private readonly selectedPaths = new Map<string, boolean>();
	private relatedNotes: RelatedNote[];
	private groups: RelatedGroups;
	private targetFolder = '';
	private activeGroup: RelationGroup = 'outgoing';
	private groupingMode: GroupingMode;
	private hideCompliant: boolean;
	private merging: boolean;
	private readonly showSourceColumn: boolean;
	private moveButton?: HTMLButtonElement;
	private undoButton?: HTMLButtonElement;
	private lastMove: MoveRecord[] = [];

	constructor(
		private readonly app: App,
		private readonly containerEl: HTMLElement,
		private readonly sourceFile: TFile,
		private readonly sourceFiles: TFile[],
		relatedNotes: RelatedNote[],
		private readonly host: RelatedNotesHost,
		private readonly sourceLabel = sourceFile.basename,
		private readonly sourceCount = sourceFiles.length,
		private readonly settings?: RelatedOperationsSettings,
		private readonly saveSettings?: () => Promise<void>,
		initialMerging = false,
		private readonly onMergingChange?: (merging: boolean) => void,
	) {
		this.relatedNotes = [...relatedNotes];
		this.showSourceColumn = sourceCount > 1;
		this.groupingMode = settings?.groupingMode ?? DEFAULT_SETTINGS.groupingMode;
		this.hideCompliant = settings?.hideCompliant ?? DEFAULT_SETTINGS.hideCompliant;
		this.merging = initialMerging;
		this.groups = buildRelatedGroups(this.relatedNotes);
	}

	/** 受控只读入口：供外部只读检查当前勾选；写入仍须经由面板自身流程。 */
	get selections(): ReadonlyMap<string, boolean> {
		return this.selectedPaths;
	}

	private buildListHost(): RelatedNotesListHost {
		return {
			app: this.app,
			containerEl: this.containerEl,
			sourceFile: this.sourceFile,
			sourceCount: this.sourceCount,
			showSourceColumn: this.showSourceColumn,
			settings: this.settings,
			saveSettings: this.saveSettings,
			onMergingChange: this.onMergingChange,
			relatedNotes: () => this.relatedNotes,
			groups: () => this.groups,
			selections: () => this.selectedPaths,
			targetFolder: () => this.targetFolder,
			activeGroup: () => this.activeGroup,
			groupingMode: () => this.groupingMode,
			setGroupingMode: (value) => { this.groupingMode = value; },
			hideCompliant: () => this.hideCompliant,
			setHideCompliant: (value) => { this.hideCompliant = value; },
			merging: () => this.merging,
			setMerging: (value) => { this.merging = value; },
			renderList: () => this.renderList(),
			refreshSelectAll: () => this.refreshSelectAll(),
			syncRowCheckboxes: (group) => this.syncRowCheckboxes(group),
			updateSelectionSummary: () => this.updateSelectionSummary(),
			updateSelectAllState: (selectAll, group) => this.updateSelectAllState(selectAll, group),
			updateMoveButton: () => this.updateMoveButton(),
		};
	}

	private buildMoveHost(): RelatedNotesMoveHost {
		return {
			app: this.app,
			relatedNotes: () => this.relatedNotes,
			selections: () => this.selectedPaths,
			targetFolder: () => this.targetFolder,
			lastMove: () => this.lastMove,
			setLastMove: (records) => { this.lastMove = records; },
			updateUndoButton: () => this.updateUndoButton(),
			pruneMovedNotes: (movedPaths) => this.pruneMovedNotes(movedPaths),
			recomputeRelatedNotes: () => this.recomputeRelatedNotes(),
		};
	}

	render() {
		this.containerEl.empty();
		this.containerEl.addClass('related-operations-panel');
		this.containerEl.toggleClass('has-source-column', this.showSourceColumn);
		this.targetFolder = joinVaultPath(parentFolder(this.sourceFile.path), 'Pages');
		const header = this.containerEl.createDiv({ cls: 'related-operations-header' });
		this.renderSelectedSourceSummary(header);
		this.renderTargetControls(header);
		this.renderTabs();
		this.renderList();
		this.renderActions();
	}

	private renderSelectedSourceSummary(container: HTMLElement) {
		if (this.sourceCount === 1) {
			const selectedSource = container.createDiv({ cls: 'related-operations-selected-sources is-single' });
			selectedSource.createSpan({ text: '源笔记：' });
			this.addSourceLink(selectedSource, this.sourceFiles[0] ?? this.sourceFile);
			return;
		}
		const selectedSources = container.createEl('details', { cls: 'related-operations-selected-sources' });
		const summary = selectedSources.createEl('summary');
		summary.setText(`已选择源笔记（${this.sourceFiles.length}）`);
		const sourceList = selectedSources.createDiv({ cls: 'related-operations-selected-source-list' });
		for (const source of this.sourceFiles) {
			this.addSourceLink(sourceList, source);
		}
	}

	private addSourceLink(container: HTMLElement, source: TFile) {
		const link = container.createEl('a', { text: source.path, cls: 'related-operations-source-link' });
		link.title = source.path;
		link.addEventListener('click', (event) => {
			event.preventDefault();
			void this.app.workspace.openLinkText(source.path, this.sourceFile.path, 'tab');
		});
	}

	private renderTargetControls(container: HTMLElement) {
		const target = container.createDiv({ cls: 'related-operations-target-row' });
		addFolderInput(this.app, target, '目标文件夹', this.targetFolder, 'related-operations-target-folder', (value) => {
			this.targetFolder = value;
			this.updatePreviews();
		});
		const shortcuts = target.createDiv({ cls: 'related-operations-target-shortcuts' });
		for (const [label, value] of [['当前目录', parentFolder(this.sourceFile.path)], ['源笔记名目录', defaultTargetFolder(this.sourceFile)], ['当前目录/Pages', joinVaultPath(parentFolder(this.sourceFile.path), 'Pages')]] as const) {
			const button = shortcuts.createEl('button', { text: label });
			button.type = 'button';
			button.addEventListener('click', () => {
				this.targetFolder = value;
				const input = this.containerEl.querySelector<HTMLInputElement>('.related-operations-target-folder');
				if (input) input.value = value;
				this.updatePreviews();
			});
		}
		target.createSpan({ text: '→', cls: 'related-operations-target-arrow' });
		const preview = target.createDiv({ cls: 'related-operations-final-target-inline' });
		preview.createEl('strong', { text: '目标：' });
		preview.createSpan({ cls: 'related-operations-final-target-text' });
		this.updatePreviews();
	}

	private renderTabs() {
		this.containerEl.querySelector('.related-operations-tabs')?.remove();
		const tabs = this.containerEl.createDiv({ cls: 'related-operations-tabs' });
		const list = this.containerEl.querySelector('.related-operations-list');
		const actions = this.containerEl.querySelector('.related-operations-actions');
		this.containerEl.insertBefore(tabs, list ?? actions ?? null);
		for (const [group, label] of [
			['outgoing', '出链'],
			['incoming', '入链'],
			['both', '双向链接'],
		] as const) {
			const tab = tabs.createEl('button', {
				text: `${label} (${uniqueCount(this.groups[group])})`,
				cls: group === this.activeGroup ? 'related-operations-tab is-active' : 'related-operations-tab',
			});
			tab.addEventListener('click', () => {
				this.activeGroup = group;
				this.renderTabs();
				this.renderList();
			});
		}
		const hint = tabs.createSpan({ text: '双向链接表示同时存在出链和入链，不计入独立总数。', cls: 'related-operations-tabs-hint' });
		hint.setAttribute('aria-label', '双向链接说明');
	}

	private renderList() {
		renderList(this.buildListHost());
	}

	private renderActions() {
		const actions = this.containerEl.createDiv({ cls: 'related-operations-actions' });
		const returnButton = actions.createEl('button', { text: '返回当前笔记' });
		returnButton.addEventListener('click', () => {
			void this.app.workspace.openLinkText(this.sourceFile.path, this.sourceFile.path, false);
		});
		const moveButton = actions.createEl('button', { text: '移动选中笔记', cls: 'mod-cta' });
		this.moveButton = moveButton;
		moveButton.addEventListener('click', () => void this.moveSelected());
		const undoButton = actions.createEl('button', { text: '撤销本次移动', cls: 'related-operations-undo' });
		this.undoButton = undoButton;
		undoButton.addEventListener('click', () => void this.undoLastMove());
		const cancelButton = actions.createEl('button', { text: '关闭' });
		cancelButton.addEventListener('click', () => this.host.close());
		this.updateMoveButton();
		this.updateUndoButton();
	}

	private updateUndoButton() {
		if (!this.undoButton) return;
		this.undoButton.disabled = this.lastMove.length === 0;
		this.undoButton.setText(this.lastMove.length > 0 ? `撤销本次移动（${this.lastMove.length}）` : '撤销本次移动');
	}

	private refreshSelectAll() {
		const button = this.containerEl.querySelector<HTMLButtonElement>('.related-operations-select-all');
		if (button) this.updateSelectAllState(button, this.groups[this.activeGroup]);
	}

	private syncRowCheckboxes(group: RelatedNote[]) {
		syncRowCheckboxes(this.buildListHost(), group);
	}

	private updateSelectionSummary() {
		updateSelectionSummary(this.buildListHost());
	}

	private updateMoveButton() {
		if (this.moveButton) this.moveButton.disabled = !this.relatedNotes.some((note) => this.selectedPaths.get(note.file.path) === true && !isAlreadyAtTarget(note.file, this.targetFolder));
	}

	private updateSelectAllState(selectAll: HTMLButtonElement, group: RelatedNote[]) {
		updateSelectAllState(this.buildListHost(), selectAll, group);
	}

	private updatePreviews() {
		updatePreviews(this.buildListHost());
	}

	private async moveSelected() {
		await moveSelectedWithHost(this.buildMoveHost());
	}

	private async undoLastMove() {
		await undoLastMoveWithHost(this.buildMoveHost());
	}

	private recomputeRelatedNotes() {
		this.relatedNotes = getRelatedNotesForFiles(this.app, this.sourceFiles);
		for (const path of [...this.selectedPaths.keys()]) {
			if (!this.relatedNotes.some((note) => note.file.path === path)) this.selectedPaths.delete(path);
		}
		this.groups = buildRelatedGroups(this.relatedNotes);
		this.renderTabs();
		this.renderList();
		this.updateUndoButton();
	}

	private pruneMovedNotes(movedPaths: Set<string>) {
		if (movedPaths.size === 0) return;
		this.relatedNotes = this.relatedNotes.filter((note) => !movedPaths.has(note.file.path));
		for (const path of movedPaths) this.selectedPaths.delete(path);
		this.groups = buildRelatedGroups(this.relatedNotes);
		this.renderTabs();
		this.renderList();
	}

	private async moveFiles(targetFolder: string, selected: TFile[], initiallySkipped: string[] = []) {
		return moveFilesWithHost(this.buildMoveHost(), targetFolder, selected, initiallySkipped);
	}
}
