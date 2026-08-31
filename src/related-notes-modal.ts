import { App, Modal, normalizePath, Notice, TFile, TFolder } from 'obsidian';
import { RelatedNote, relationLabel } from './related-notes';
import { RelatedOperationsSettings } from './settings';
import { isVaultRelativePath, joinVaultPath } from './core-utils';

export interface RelatedNotesHost {
	close(): void;
}

interface MoveResult {
	succeeded: string[];
	skipped: string[];
	failed: Array<{ path: string; reason: string }>;
}

export class RelatedNotesPanel {
	private readonly selections = new Map<string, boolean>();
	private relatedNotes: RelatedNote[];
	private groups: Record<'outgoing' | 'incoming' | 'both', RelatedNote[]>;
	private targetFolder = '';
	private activeGroup: 'outgoing' | 'incoming' | 'both' = 'outgoing';
	private groupingMode: 'none' | 'source' | 'path';
	private hideCompliant: boolean;
	private readonly showSourceColumn: boolean;
	private moveButton?: HTMLButtonElement;

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
	) {
		this.relatedNotes = [...relatedNotes];
		this.showSourceColumn = sourceCount > 1;
		this.groupingMode = settings?.groupingMode ?? 'source';
		this.hideCompliant = settings?.hideCompliant ?? true;
		this.groups = this.buildGroups();
	}

	private buildGroups() {
		return {
			outgoing: this.relatedNotes.filter((note) => note.relation === 'outgoing' || note.relation === 'both').sort((a, b) => this.sortNotes(a, b)),
			incoming: this.relatedNotes.filter((note) => note.relation === 'incoming' || note.relation === 'both').sort((a, b) => this.sortNotes(a, b)),
			both: this.relatedNotes.filter((note) => note.relation === 'both').sort((a, b) => this.sortNotes(a, b)),
		};
	}

	render() {
		this.containerEl.empty();
		this.containerEl.addClass('related-operations-panel');
		this.containerEl.toggleClass('has-source-column', this.showSourceColumn);
		this.targetFolder = joinVaultPath(this.parentFolder(this.sourceFile.path), 'Pages');
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

	private parentFolder(path: string) {
		const slash = path.lastIndexOf('/');
		return slash >= 0 ? path.slice(0, slash) : '';
	}

	private sortNotes(a: RelatedNote, b: RelatedNote) {
		const folderCompare = this.parentFolder(a.file.path).localeCompare(this.parentFolder(b.file.path));
		const sourceCompare = a.sourceFile.path.localeCompare(b.sourceFile.path);
		return folderCompare || sourceCompare || a.file.path.localeCompare(b.file.path);
	}

	private sortForDisplay(a: RelatedNote, b: RelatedNote) {
		const sourceCompare = a.sourceFile.path.localeCompare(b.sourceFile.path);
		const folderCompare = this.parentFolder(a.file.path).localeCompare(this.parentFolder(b.file.path));
		return this.groupingMode === 'source'
			? sourceCompare || folderCompare || a.file.path.localeCompare(b.file.path)
			: folderCompare || sourceCompare || a.file.path.localeCompare(b.file.path);
	}

	private renderTargetControls(container: HTMLElement) {
		const target = container.createDiv({ cls: 'related-operations-target-row' });
		this.addFolderInput(target, '目标文件夹', this.targetFolder, 'related-operations-target-folder', (value) => {
			this.targetFolder = value;
			this.updatePreviews();
		});
		const shortcuts = target.createDiv({ cls: 'related-operations-target-shortcuts' });
		for (const [label, value] of [['当前目录', this.parentFolder(this.sourceFile.path)], ['源笔记名目录', joinVaultPath(this.parentFolder(this.sourceFile.path), this.sourceFile.basename)], ['当前目录/Pages', joinVaultPath(this.parentFolder(this.sourceFile.path), 'Pages')]] as const) {
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

	private addFolderInput(
		container: HTMLElement,
		label: string,
		value: string,
		className: string,
		onInput: (value: string) => void,
	) {
		const field = container.createDiv({ cls: 'related-operations-folder-field' });
		field.createEl('label', { text: label });
		const input = field.createEl('input', { type: 'text', value });
		input.addClass(className);
		const suggestions = field.createDiv({ cls: 'related-operations-folder-suggestions' });
		const relative = false;
		input.addEventListener('focus', () => {
			this.populateFolderSuggestions(suggestions, input, relative);
			suggestions.addClass('is-visible');
		});
		input.addEventListener('input', () => {
			onInput(input.value);
			this.populateFolderSuggestions(suggestions, input, relative);
			suggestions.addClass('is-visible');
		});
		input.addEventListener('blur', () => {
			window.setTimeout(() => suggestions.removeClass('is-visible'), 150);
		});
		this.populateFolderSuggestions(suggestions, input, relative);
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
				text: `${label} (${this.uniqueCount(this.groups[group])})`,
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

	private uniqueCount(group: RelatedNote[]) {
		return new Set(group.map((note) => note.file.path)).size;
	}

	private renderList() {
		this.containerEl.querySelector('.related-operations-list')?.remove();
		const wrapper = this.containerEl.createDiv({ cls: 'related-operations-list' });
		const actions = this.containerEl.querySelector('.related-operations-actions');
		this.containerEl.insertBefore(wrapper, actions ?? null);
		const currentGroup = this.groups[this.activeGroup];
		const displayToolbar = wrapper.createDiv({ cls: 'related-operations-list-toolbar related-operations-display-toolbar' });
		const displayOptions = displayToolbar.createDiv({ cls: 'related-operations-display-options' });
		const displayOptionsBody = displayOptions.createDiv({ cls: 'related-operations-display-options-body' });
		const grouping = displayOptionsBody.createEl('select', { cls: 'related-operations-grouping-select' });
		for (const [value, label] of [['none', '不分组'], ['source', '按源笔记分组'], ['path', '按当前路径分组']] as const) {
			grouping.createEl('option', { value, text: label });
		}
		grouping.value = this.sourceCount === 1 && this.groupingMode === 'source' ? 'none' : this.groupingMode;
		if (this.sourceCount === 1) grouping.querySelector('option[value="source"]')?.remove();
		grouping.addEventListener('change', () => {
			this.groupingMode = grouping.value as 'none' | 'source' | 'path';
			if (this.settings) this.settings.groupingMode = this.groupingMode;
			void this.saveSettings?.();
			this.renderList();
		});
		const hiddenCount = this.uniqueCount(currentGroup.filter((note) => this.isAlreadyAtTarget(note.file)));
		const hideButton = displayOptionsBody.createEl('button', {
			text: this.hideCompliant ? `显示已在目标文件夹的笔记（${hiddenCount}）` : `隐藏已在目标文件夹的笔记${hiddenCount > 0 ? `（${hiddenCount}）` : ''}`,
			cls: 'related-operations-hide-button',
		});
		hideButton.type = 'button';
		hideButton.setAttribute('aria-pressed', String(this.hideCompliant));
		hideButton.addEventListener('click', () => {
			this.hideCompliant = !this.hideCompliant;
			if (this.settings) this.settings.hideCompliant = this.hideCompliant;
			void this.saveSettings?.();
			this.renderList();
		});
		const selectionToolbar = displayToolbar;
		const selectAllMovable = selectionToolbar.createEl('button', { text: '全选所有可移动笔记', cls: 'related-operations-select-all-action' });
		selectAllMovable.type = 'button';
		selectAllMovable.title = '选择所有标签页中可移动的关联笔记';
		selectAllMovable.addEventListener('click', () => {
			for (const note of this.relatedNotes) {
				if (!this.isAlreadyAtTarget(note.file)) this.selections.set(note.file.path, true);
			}
			this.syncRowCheckboxes(this.relatedNotes);
			this.refreshSelectAll();
			this.updateSelectionSummary();
		});
		const clearSelection = selectionToolbar.createEl('button', { text: '清空选择' });
		clearSelection.type = 'button';
		clearSelection.addEventListener('click', () => {
			this.selections.clear();
			this.syncRowCheckboxes(this.relatedNotes);
			this.refreshSelectAll();
			this.updateSelectionSummary();
		});
		const selectAll = selectionToolbar.createEl('button', { text: '全选当前分组', cls: 'related-operations-select-all' });
		selectAll.type = 'button';
		selectAll.addEventListener('click', () => {
			const movable = currentGroup.filter((note) => !this.isAlreadyAtTarget(note.file));
			const allSelected = movable.length > 0 && movable.every((note) => this.selections.get(note.file.path) === true);
			for (const note of movable) this.selections.set(note.file.path, !allSelected);
			this.syncRowCheckboxes(currentGroup);
			this.updateSelectAllState(selectAll, currentGroup);
			this.updateSelectionSummary();
		});
		const selectionSummary = selectionToolbar.createSpan({ cls: 'related-operations-selection-summary' });
		selectionSummary.setAttribute('aria-live', 'polite');
		this.updateSelectAllState(selectAll, currentGroup);
		this.updateSelectionSummary();

		if (currentGroup.length === 0) {
			wrapper.createEl('p', { text: '暂无关联笔记。', cls: 'related-operations-empty' });
			return;
		}
		const displayGroup = (this.hideCompliant
			? currentGroup.filter((note) => !this.isAlreadyAtTarget(note.file))
			: currentGroup).sort((a, b) => this.sortForDisplay(a, b));
		if (displayGroup.length === 0) {
			wrapper.createEl('p', { text: `所有条目都已符合目标，已隐藏 ${hiddenCount} 条。`, cls: 'related-operations-empty' });
			return;
		}

		const tableScroll = wrapper.createDiv({ cls: 'related-operations-table-scroll' });
		const table = tableScroll.createEl('table', { cls: 'related-operations-table' });
		const thead = table.createEl('thead');
		const header = thead.createEl('tr');
		const headers = this.showSourceColumn
			? ['选择', '源笔记', '关联笔记', '当前路径', '关系', '目标路径预览']
			: ['选择', '笔记名称', '当前路径', '关系', '目标路径预览'];
		for (const title of headers) header.createEl('th', { text: title });
		const tbody = table.createEl('tbody');
		let previousFolder = '';
		let previousSource = '';
		for (let index = 0; index < displayGroup.length; index++) {
			const note = displayGroup[index];
			if (!note) continue;
			const groupLabel = this.groupingMode === 'source'
				? note.sourceFile.path
				: this.groupingMode === 'path'
					? this.parentFolder(note.file.path) || '根目录'
					: '';
			if (groupLabel && groupLabel !== previousFolder) {
				const groupRow = tbody.createEl('tr', { cls: 'related-operations-path-group' });
				groupRow.createEl('td', { text: groupLabel, attr: { colspan: this.showSourceColumn ? '6' : '5' } });
				previousFolder = groupLabel;
				previousSource = '';
			}
			const row = tbody.createEl('tr');
			row.dataset.relatedPath = note.file.path;
			row.dataset.relatedKey = this.relatedKey(note);
			const alreadyAtTarget = this.isAlreadyAtTarget(note.file);
			if (alreadyAtTarget) row.addClass('is-already-target');
			const checkCell = row.createEl('td');
			const checkbox = checkCell.createEl('input', { type: 'checkbox' });
			checkbox.checked = this.selections.get(note.file.path) ?? false;
			checkbox.setAttribute('aria-label', `选择 ${note.file.path}`);
			checkbox.disabled = alreadyAtTarget;
			if (alreadyAtTarget) checkbox.title = '该笔记已经位于目标文件夹';
			checkbox.addEventListener('change', () => {
				this.selections.set(note.file.path, checkbox.checked);
				this.refreshSelectAll();
				this.updateSelectionSummary();
			});
			if (this.showSourceColumn) {
				if (note.sourceFile.path !== previousSource) {
					const sourceCell = row.createEl('td');
					let rowSpan = 1;
					while (displayGroup[index + rowSpan]?.sourceFile.path === note.sourceFile.path) rowSpan++;
					sourceCell.rowSpan = rowSpan;
					const sourceLink = sourceCell.createEl('a', {
						text: note.sourceFile.basename,
						cls: 'related-operations-note-link',
					});
					sourceLink.title = note.sourceFile.path;
					sourceLink.addEventListener('click', (event) => {
						event.preventDefault();
						void this.app.workspace.openLinkText(note.sourceFile.path, this.sourceFile.path, 'tab');
					});
				}
				previousSource = note.sourceFile.path;
			}
			const nameCell = row.createEl('td');
			const link = nameCell.createEl('a', { text: note.file.basename, cls: 'related-operations-note-link' });
			link.title = note.file.path;
			link.addEventListener('click', (event) => {
				event.preventDefault();
				void this.app.workspace.openLinkText(note.file.path, this.sourceFile.path, 'tab');
			});
			row.createEl('td', { text: note.file.path, cls: 'related-operations-path' });
			row.createEl('td', { text: relationLabel(note.relation) });
			row.createEl('td', { text: this.destinationFor(note.file), cls: 'related-operations-path' });
		}
	}

	private addToggle(
		container: HTMLElement,
		text: string,
		className: string,
		checked: boolean,
		onChange: (checked: boolean) => void,
	) {
		const label = container.createEl('label', { cls: 'related-operations-toggle' });
		const input = label.createEl('input', { type: 'checkbox', cls: className });
		input.checked = checked;
		input.addEventListener('change', () => onChange(input.checked));
		label.createSpan({ text });
		return input;
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
		const cancelButton = actions.createEl('button', { text: '关闭' });
		cancelButton.addEventListener('click', () => this.host.close());
		this.updateMoveButton();
	}

	private refreshSelectAll() {
		const button = this.containerEl.querySelector<HTMLButtonElement>('.related-operations-select-all');
		if (button) this.updateSelectAllState(button, this.groups[this.activeGroup]);
	}

	private syncRowCheckboxes(group: RelatedNote[]) {
		const paths = new Set(group.map((note) => note.file.path));
		this.containerEl.querySelectorAll<HTMLInputElement>('tr[data-related-path] input[type="checkbox"]').forEach((checkbox) => {
			const row = checkbox.closest<HTMLElement>('tr[data-related-path]');
			const path = row?.dataset.relatedPath;
			if (path && paths.has(path)) checkbox.checked = this.selections.get(path) === true;
		});
	}

	private updateSelectionSummary() {
		const summary = this.containerEl.querySelector<HTMLElement>('.related-operations-selection-summary');
		if (!summary) return;
		const selectedByPath = new Map(
			this.relatedNotes
				.filter((note) => this.selections.get(note.file.path) === true)
				.map((note) => [note.file.path, note.file.basename]),
		);
		const selected = [...selectedByPath.entries()];
		const nameCounts = new Map<string, number>();
		for (const [, name] of selected) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
		const labels = selected.map(([path, name]) => (nameCounts.get(name) === 1 ? name : `${name}（${path}）`));
		summary.setText(selected.length === 1 ? `已选：${labels[0]}（跨标签页）` : `已选 ${selected.length} 篇（跨标签页）`);
		summary.setAttribute('title', labels.length > 0 ? labels.join('\n') : '尚未选择笔记');
		this.updateMoveButton();
	}

	private updateMoveButton() {
		if (this.moveButton) this.moveButton.disabled = !this.relatedNotes.some((note) => this.selections.get(note.file.path) === true && !this.isAlreadyAtTarget(note.file));
	}

	private updateSelectAllState(selectAll: HTMLButtonElement, group: RelatedNote[]) {
		const movable = group.filter((note) => !this.isAlreadyAtTarget(note.file));
		const selected = movable.filter((note) => this.selections.get(note.file.path) === true).length;
		const allSelected = movable.length > 0 && selected === movable.length;
		selectAll.setText(allSelected ? '取消全选当前分组' : '全选当前分组');
		selectAll.setAttribute('aria-pressed', String(allSelected));
		selectAll.disabled = movable.length === 0;
	}

	private updatePreviews() {
		const finalTarget = this.finalTarget();
		this.containerEl.querySelector('.related-operations-final-target-text')?.setText(finalTarget || '（当前笔记所在文件夹）');
		this.containerEl.querySelectorAll<HTMLElement>('.related-operations-table tr[data-related-path]').forEach((row) => {
			const note = this.groups[this.activeGroup].find((candidate) => this.relatedKey(candidate) === row.dataset.relatedKey);
			if (!note) return;
			const alreadyAtTarget = this.isAlreadyAtTarget(note.file);
			row.toggleClass('is-already-target', alreadyAtTarget);
			const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
			if (checkbox) {
				checkbox.disabled = alreadyAtTarget;
				checkbox.title = alreadyAtTarget ? '该笔记已经位于目标文件夹' : '';
			}
			row.children[this.showSourceColumn ? 5 : 4]?.setText(this.destinationFor(note.file));
		});
		for (const [path, selected] of this.selections) {
			if (selected) {
				const note = this.relatedNotes.find((candidate) => candidate.file.path === path);
				if (!note || this.isAlreadyAtTarget(note.file)) this.selections.delete(path);
			}
		}
		this.syncRowCheckboxes(this.relatedNotes);
		this.refreshSelectAll();
		this.updateSelectionSummary();
	}

	private populateFolderSuggestions(container: HTMLElement, input: HTMLInputElement, relative: boolean) {
		container.empty();
		const values = this.app.vault.getAllLoadedFiles()
			.filter((file): file is TFolder => file instanceof TFolder)
			.map((folder) => folder.path)
			.filter((path) => relative ? false : true)
			.filter((path) => path.toLowerCase().includes(input.value.trim().toLowerCase()));
		for (const value of values.sort()) {
			const option = container.createEl('button', { text: value, cls: 'related-operations-folder-suggestion' });
			option.type = 'button';
			option.addEventListener('mousedown', (event) => event.preventDefault());
			option.addEventListener('click', () => {
				input.value = value;
				input.dispatchEvent(new Event('input'));
				container.removeClass('is-visible');
			});
		}
	}

	private finalTarget() {
		return normalizePath(this.targetFolder.trim()).replace(/^\/+|\/+$/g, '');
	}

	private destinationFor(file: TFile) {
		const target = this.finalTarget();
		return target ? `${target}/${file.name}` : file.name;
	}

	private relatedKey(note: RelatedNote) {
		return `${note.sourceFile?.path ?? this.sourceFile.path}\u0000${note.file.path}`;
	}

	private isAlreadyAtTarget(file: TFile) {
		return normalizePath(this.parentFolder(file.path)).toLowerCase() === normalizePath(this.finalTarget()).toLowerCase();
	}

	private async moveSelected() {
		const targetFolder = this.finalTarget();
		if (!targetFolder || !isVaultRelativePath(targetFolder)) {
			new Notice('请输入 vault 内的目标文件夹。');
			return;
		}
		const selected = [...this.selections.entries()]
			.filter(([, checked]) => checked)
			.map(([path]) => this.relatedNotes.find((note) => note.file.path === path))
			.filter((note): note is RelatedNote => note !== undefined);
		if (selected.length === 0) {
			new Notice('请至少选择一篇关联笔记。');
			return;
		}
		const selectedFiles = [...new Map(selected.map((note) => [note.file.path, note.file])).values()];
		const conflicts = selectedFiles.filter((file) => {
			const destination = normalizePath(`${targetFolder}/${file.name}`);
			return destination.toLowerCase() !== file.path.toLowerCase() && this.pathExistsCaseInsensitive(destination);
		});
		const movable = selectedFiles.filter((file) => !conflicts.includes(file) && !this.isAlreadyAtTarget(file));
		if (movable.length === 0) {
			new Notice('所选笔记都已经在目标文件夹或存在冲突。');
			return;
		}
		const confirmed = await new MoveConfirmationModal(
			this.app,
			targetFolder,
			movable.length,
			conflicts.length,
		).waitForConfirmation();
		if (!confirmed) return;
		const result = await this.moveFiles(targetFolder, movable, conflicts.map((file) => file.path));
		new Notice(this.formatResult(result));
		if (result.failed.length === 0) {
			this.host.close();
			return;
		}
		this.pruneMovedNotes(new Set(result.succeeded));
	}

	private pruneMovedNotes(movedPaths: Set<string>) {
		if (movedPaths.size === 0) return;
		this.relatedNotes = this.relatedNotes.filter((note) => !movedPaths.has(note.file.path));
		for (const path of movedPaths) this.selections.delete(path);
		this.groups = this.buildGroups();
		this.renderTabs();
		this.renderList();
	}

	private formatResult(result: MoveResult) {
		const lines = [`已移动：${result.succeeded.length}`, `已跳过：${result.skipped.length}`, `失败：${result.failed.length}`];
		if (result.skipped.length) lines.push(`跳过文件：${result.skipped.join('、')}`);
		if (result.failed.length) lines.push(`失败文件：${result.failed.map((item) => `${item.path}（${item.reason}）`).join('、')}`);
		return lines.join('\n');
	}

	private async moveFiles(targetFolder: string, selected: TFile[], initiallySkipped: string[] = []): Promise<MoveResult> {
		const result: MoveResult = { succeeded: [], skipped: initiallySkipped, failed: [] };
		try {
			await this.ensureFolder(targetFolder);
		} catch {
			result.failed.push({ path: targetFolder, reason: '无法创建或访问目标文件夹' });
			return result;
		}
		for (const file of selected) {
			const destination = normalizePath(`${targetFolder}/${file.name}`);
			if (destination.toLowerCase() === file.path.toLowerCase() || this.pathExistsCaseInsensitive(destination)) {
				result.skipped.push(file.path);
				continue;
			}
			try {
				await this.app.fileManager.renameFile(file, destination);
				result.succeeded.push(file.path);
			} catch (error) {
				const reason = error instanceof Error ? error.message : '未知错误';
				result.failed.push({ path: file.path, reason });
			}
		}
		return result;
	}

	private pathExistsCaseInsensitive(path: string) {
		const normalized = path.toLowerCase();
		return this.app.vault.getAllLoadedFiles().some((file) => file.path.toLowerCase() === normalized);
	}

	private async ensureFolder(path: string) {
		let current = '';
		for (const segment of path.split('/').filter(Boolean)) {
			current = current ? `${current}/${segment}` : segment;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) continue;
			if (existing) throw new Error(`Path is not a folder: ${current}`);
			await this.app.vault.createFolder(current);
		}
	}
}

export class RelatedNotesModal extends Modal {
	private panel?: RelatedNotesPanel;

	constructor(
		app: App,
		private readonly sourceFile: TFile,
		private readonly sourceFiles: TFile[],
		private readonly relatedNotes: RelatedNote[],
		private readonly sourceLabel = sourceFile.basename,
		private readonly sourceCount = sourceFiles.length,
		private readonly settings?: RelatedOperationsSettings,
		private readonly saveSettings?: () => Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(`整理关联笔记：${this.sourceLabel}`);
		this.panel = new RelatedNotesPanel(
			this.app,
			this.contentEl,
			this.sourceFile,
			this.sourceFiles,
			this.relatedNotes,
			this,
			this.sourceLabel,
			this.sourceCount,
			this.settings,
			this.saveSettings,
		);
		this.panel.render();
	}

	onClose() {
		this.contentEl.empty();
	}
}

class MoveConfirmationModal extends Modal {
	private resolver?: (confirmed: boolean) => void;
	private settled = false;

	constructor(
		app: App,
		private readonly targetFolder: string,
		private readonly movableCount: number,
		private readonly conflictCount: number,
	) {
		super(app);
	}

	waitForConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolver = resolve;
			this.open();
		});
	}

	onOpen() {
		this.titleEl.setText('确认整理笔记');
		this.contentEl.empty();
			this.contentEl.createEl('p', { text: `即将整理 ${this.movableCount} 篇笔记到：` });
		this.contentEl.createEl('p', { text: this.targetFolder, cls: 'related-operations-confirm-target' });
		if (this.conflictCount > 0) {
			this.contentEl.createEl('p', {
				text: `${this.conflictCount} 篇笔记存在冲突，将自动跳过。`,
				cls: 'related-operations-confirm-warning',
			});
		}
		const actions = this.contentEl.createDiv({ cls: 'related-operations-actions' });
		const confirm = actions.createEl('button', { text: '确认整理', cls: 'mod-cta' });
		confirm.addEventListener('click', () => this.finish(true));
		const cancel = actions.createEl('button', { text: '取消' });
		cancel.addEventListener('click', () => this.finish(false));
	}

	onClose() {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.resolver?.(false);
		}
	}

	private finish(confirmed: boolean) {
		if (this.settled) return;
		this.settled = true;
		this.resolver?.(confirmed);
		this.close();
	}
}
