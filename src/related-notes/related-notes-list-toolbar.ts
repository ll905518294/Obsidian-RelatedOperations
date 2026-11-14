import type { RelatedNote } from '../related-notes';
import { isAlreadyAtTarget, type GroupingMode } from './related-notes-model';
import type { RelatedNotesListHost } from './related-notes-list-host';

export function renderListToolbar(
	host: RelatedNotesListHost,
	wrapper: HTMLElement,
	currentGroup: RelatedNote[],
	hiddenCount: number,
): { effectiveGrouping: GroupingMode; selectAll: HTMLButtonElement } {
	const displayToolbar = wrapper.createDiv({ cls: 'related-operations-list-toolbar related-operations-display-toolbar' });
	const displayOptions = displayToolbar.createDiv({ cls: 'related-operations-display-options' });
	const displayOptionsBody = displayOptions.createDiv({ cls: 'related-operations-display-options-body' });
	const mergeButton = displayOptionsBody.createEl('button', {
		text: host.merging() ? '按来源分行展示（关闭合并）' : '合并同一目标笔记',
		cls: 'related-operations-merge-button',
	});
	mergeButton.type = 'button';
	mergeButton.title = '多个来源指向同一目标笔记时，将其合并为一行。';
	mergeButton.setAttribute('aria-pressed', String(host.merging()));
	mergeButton.addEventListener('click', () => {
		host.setMerging(!host.merging());
		host.onMergingChange?.(host.merging());
		host.renderList();
	});
	const grouping = displayOptionsBody.createEl('select', { cls: 'related-operations-grouping-select' });
	for (const [value, label] of [['none', '不分组'], ['source', '按源笔记分组'], ['path', '按当前路径分组']] as const) {
		grouping.createEl('option', { value, text: label });
	}
	// Merged rows can span several source notes, so source grouping would
	// fight the merge; fall back to no grouping while merging.
	const effectiveGrouping = (host.merging() || host.sourceCount === 1) && host.groupingMode() === 'source'
		? 'none'
		: host.groupingMode();
	grouping.value = effectiveGrouping;
	if (host.sourceCount === 1) grouping.querySelector('option[value="source"]')?.remove();
	grouping.addEventListener('change', () => {
		const nextGrouping = grouping.value as GroupingMode;
		host.setGroupingMode(nextGrouping);
		if (host.settings) host.settings.groupingMode = nextGrouping;
		void host.saveSettings?.();
		host.renderList();
	});
	const hideButton = displayOptionsBody.createEl('button', {
		text: host.hideCompliant() ? `显示已在目标文件夹的笔记（${hiddenCount}）` : `隐藏已在目标文件夹的笔记${hiddenCount > 0 ? `（${hiddenCount}）` : ''}`,
		cls: 'related-operations-hide-button',
	});
	hideButton.type = 'button';
	hideButton.setAttribute('aria-pressed', String(host.hideCompliant()));
	hideButton.addEventListener('click', () => {
		const nextHideCompliant = !host.hideCompliant();
		host.setHideCompliant(nextHideCompliant);
		if (host.settings) host.settings.hideCompliant = nextHideCompliant;
		void host.saveSettings?.();
		host.renderList();
	});
	const selectionToolbar = displayToolbar;
	const selectAllMovable = selectionToolbar.createEl('button', { text: '全选所有可移动笔记', cls: 'related-operations-select-all-action' });
	selectAllMovable.type = 'button';
	selectAllMovable.title = '选择所有标签页中可移动的关联笔记';
	selectAllMovable.addEventListener('click', () => {
		for (const note of host.relatedNotes()) {
			if (!isAlreadyAtTarget(note.file, host.targetFolder())) host.selections().set(note.file.path, true);
		}
		host.syncRowCheckboxes(host.relatedNotes());
		host.refreshSelectAll();
		host.updateSelectionSummary();
	});
	const clearSelection = selectionToolbar.createEl('button', { text: '清空选择' });
	clearSelection.type = 'button';
	clearSelection.addEventListener('click', () => {
		host.selections().clear();
		host.syncRowCheckboxes(host.relatedNotes());
		host.refreshSelectAll();
		host.updateSelectionSummary();
	});
	const selectAll = selectionToolbar.createEl('button', { text: '全选当前分组', cls: 'related-operations-select-all' });
	selectAll.type = 'button';
	selectAll.addEventListener('click', () => {
		const movable = currentGroup.filter((note) => !isAlreadyAtTarget(note.file, host.targetFolder()));
		const allSelected = movable.length > 0 && movable.every((note) => host.selections().get(note.file.path) === true);
		for (const note of movable) host.selections().set(note.file.path, !allSelected);
		host.syncRowCheckboxes(currentGroup);
		host.updateSelectAllState(selectAll, currentGroup);
		host.updateSelectionSummary();
	});
	const selectionSummary = selectionToolbar.createSpan({ cls: 'related-operations-selection-summary' });
	selectionSummary.setAttribute('aria-live', 'polite');
	return { effectiveGrouping, selectAll };
}
