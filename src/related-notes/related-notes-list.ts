import { relationLabel, type RelatedNote } from '../related-notes';
import {
	destinationFor,
	finalTarget,
	isAlreadyAtTarget,
	mergedRelationDetail,
	mergedRelationLabel,
	parentFolder,
	relatedKey,
	relationExplanation,
	sortForDisplay,
	uniqueCount,
} from './related-notes-model';
import { renderListToolbar } from './related-notes-list-toolbar';
import type { RelatedNotesListHost } from './related-notes-list-host';
import { createColumnHeader } from '../cleanup/cleanup-a11y';
import { makeNoteLinkActivatable } from './related-notes-a11y';

export function syncRowCheckboxes(host: RelatedNotesListHost, group: RelatedNote[]) {
	const paths = new Set(group.map((note) => note.file.path));
	host.containerEl.querySelectorAll<HTMLInputElement>('tr[data-related-path] input[type="checkbox"]').forEach((checkbox) => {
		const row = checkbox.closest<HTMLElement>('tr[data-related-path]');
		const path = row?.dataset.relatedPath;
		if (path && paths.has(path)) checkbox.checked = host.selections().get(path) === true;
	});
}

export function updateSelectionSummary(host: RelatedNotesListHost) {
	const summary = host.containerEl.querySelector<HTMLElement>('.related-operations-selection-summary');
	if (!summary) return;
	const selectedByPath = new Map(
		host.relatedNotes()
			.filter((note) => host.selections().get(note.file.path) === true)
			.map((note) => [note.file.path, note.file.basename]),
	);
	const selected = [...selectedByPath.entries()];
	const nameCounts = new Map<string, number>();
	for (const [, name] of selected) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
	const labels = selected.map(([path, name]) => (nameCounts.get(name) === 1 ? name : `${name}（${path}）`));
	summary.setText(selected.length === 1 ? `已选 1 篇（跨标签页）：${labels[0]}` : `已选 ${selected.length} 篇（跨标签页）`);
	summary.setAttribute('title', labels.length > 0 ? labels.join('\n') : '尚未选择笔记');
	host.updateMoveButton();
}

export function updateSelectAllState(host: RelatedNotesListHost, selectAll: HTMLButtonElement, group: RelatedNote[]) {
	// A target can be listed once per source but shares one selection key;
	// count unique paths so the button reflects what the user actually sees.
	const movable = new Set(group
		.filter((note) => !isAlreadyAtTarget(note.file, host.targetFolder()))
		.map((note) => note.file.path));
	const selected = [...movable].filter((path) => host.selections().get(path) === true).length;
	const allSelected = movable.size > 0 && selected === movable.size;
	selectAll.setText(allSelected ? '取消全选当前分组' : '全选当前分组');
	selectAll.setAttribute('aria-pressed', String(allSelected));
	selectAll.disabled = movable.size === 0;
}

export function updatePreviews(host: RelatedNotesListHost) {
	const target = finalTarget(host.targetFolder());
	host.containerEl.querySelector('.related-operations-final-target-text')?.setText(target || '（当前笔记所在文件夹）');
	// A hub note can surface thousands of rows, so index the visible group and
	// the full related list once instead of scanning them per row/selection.
	const groupByPath = new Map(host.groups()[host.activeGroup()].map((note) => [note.file.path, note]));
	const notesByPath = new Map(host.relatedNotes().map((note) => [note.file.path, note]));
	host.containerEl.querySelectorAll<HTMLElement>('.related-operations-table tr[data-related-path]').forEach((row) => {
		const note = groupByPath.get(row.dataset.relatedPath ?? '');
		if (!note) return;
		const alreadyAtTarget = isAlreadyAtTarget(note.file, host.targetFolder());
		row.toggleClass('is-already-target', alreadyAtTarget);
		const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
		if (checkbox) {
			checkbox.disabled = alreadyAtTarget;
			checkbox.title = alreadyAtTarget ? '该笔记已经位于目标文件夹' : '';
		}
		// Rows after the first one in a source group have no source cell
		// (rowSpan covers them), so address the target preview from the end.
		row.children[row.children.length - 1]?.setText(destinationFor(note.file, host.targetFolder()));
	});
	for (const [path, selected] of host.selections()) {
		if (selected) {
			const note = notesByPath.get(path);
			if (!note || isAlreadyAtTarget(note.file, host.targetFolder())) host.selections().delete(path);
		}
	}
	syncRowCheckboxes(host, host.relatedNotes());
	host.refreshSelectAll();
	updateSelectionSummary(host);
}

function emptyListText(host: RelatedNotesListHost) {
	if (host.relatedNotes().length > 0) return '当前标签页暂无关联笔记，可切换其他标签页查看。';
	return host.sourceCount === 1
		? '暂无关联笔记：当前笔记没有出链，也没有其他笔记链接到它。'
		: '暂无关联笔记：所选源笔记没有出链，也没有其他笔记链接到它们。';
}

export function renderList(host: RelatedNotesListHost) {
	host.containerEl.querySelector('.related-operations-list')?.remove();
	const wrapper = host.containerEl.createDiv({ cls: 'related-operations-list' });
	const actions = host.containerEl.querySelector('.related-operations-actions');
	host.containerEl.insertBefore(wrapper, actions ?? null);
	const currentGroup = host.groups()[host.activeGroup()];
	const hiddenCount = uniqueCount(currentGroup.filter((note) => isAlreadyAtTarget(note.file, host.targetFolder())));
	const { effectiveGrouping, selectAll } = renderListToolbar(host, wrapper, currentGroup, hiddenCount);
	host.updateSelectAllState(selectAll, currentGroup);
	host.updateSelectionSummary();

	if (currentGroup.length === 0) {
		wrapper.createEl('p', { text: emptyListText(host), cls: 'related-operations-empty' });
		return;
	}
	const displayGroup = (host.hideCompliant()
		? currentGroup.filter((note) => !isAlreadyAtTarget(note.file, host.targetFolder()))
		: currentGroup).sort((a, b) => sortForDisplay(a, b, host.groupingMode()));
	if (displayGroup.length === 0) {
		wrapper.createEl('p', { text: `所有条目都已符合目标，已隐藏 ${hiddenCount} 条。`, cls: 'related-operations-empty' });
		return;
	}

	// In merge mode, collapse notes that share the same target file into a
	// single row. Selections are keyed by file path, so merging only changes
	// the displayed rows: counts, select-all and the move list still treat
	// each target file once.
	const mergedRows = host.merging()
		? [...displayGroup.reduce((rows, note) => {
			const row = rows.get(note.file.path);
			if (row) row.push(note);
			else rows.set(note.file.path, [note]);
			return rows;
		}, new Map<string, RelatedNote[]>()).values()]
		: null;
	const displayRows = mergedRows ?? displayGroup.map((note) => [note]);

	const tableScroll = wrapper.createDiv({ cls: 'related-operations-table-scroll' });
	const table = tableScroll.createEl('table', { cls: 'related-operations-table' });
	const thead = table.createEl('thead');
	const header = thead.createEl('tr');
	const headers = host.showSourceColumn
		? ['选择', '源笔记', '关联笔记', '当前路径', '关系', '目标路径预览']
		: ['选择', '笔记名称', '当前路径', '关系', '目标路径预览'];
	for (const title of headers) createColumnHeader(header, title);
	const tbody = table.createEl('tbody');
	let previousFolder = '';
	let previousSource = '';
	for (let index = 0; index < displayRows.length; index++) {
		const notes = displayRows[index];
		if (!notes || notes.length === 0) continue;
		const note = notes[0];
		if (!note) continue;
		const groupLabel = effectiveGrouping === 'source'
			? note.sourceFile.path
			: effectiveGrouping === 'path'
				? parentFolder(note.file.path) || '根目录'
				: '';
		if (groupLabel && groupLabel !== previousFolder) {
			const groupRow = tbody.createEl('tr', { cls: 'related-operations-path-group' });
			groupRow.createEl('td', { text: groupLabel, attr: { colspan: host.showSourceColumn ? '6' : '5' } });
			previousFolder = groupLabel;
			previousSource = '';
		}
		const row = tbody.createEl('tr');
		row.dataset.relatedPath = note.file.path;
		row.dataset.relatedKey = relatedKey(note, host.sourceFile.path);
		const alreadyAtTarget = isAlreadyAtTarget(note.file, host.targetFolder());
		if (alreadyAtTarget) row.addClass('is-already-target');
		const checkCell = row.createEl('td');
		const checkbox = checkCell.createEl('input', { type: 'checkbox' });
		checkbox.checked = host.selections().get(note.file.path) ?? false;
		checkbox.setAttribute('aria-label', `选择 ${note.file.path}`);
		checkbox.disabled = alreadyAtTarget;
		if (alreadyAtTarget) checkbox.title = '该笔记已经位于目标文件夹';
		checkbox.addEventListener('change', () => {
			host.selections().set(note.file.path, checkbox.checked);
			// The same target may be rendered once per source. They share one
			// selection key, so checking one row must update every row for it.
			host.syncRowCheckboxes(host.relatedNotes());
			host.refreshSelectAll();
			host.updateSelectionSummary();
		});
		if (host.showSourceColumn) {
			if (host.merging()) {
				const sourceCell = notes.length > 1
					? row.createEl('td', { cls: 'related-operations-merge-sources' })
					: row.createEl('td');
				if (notes.length === 1) {
					const sourceLink = sourceCell.createEl('a', {
						text: note.sourceFile.basename,
						cls: 'related-operations-note-link',
					});
					sourceLink.title = note.sourceFile.path;
					makeNoteLinkActivatable(sourceLink, () => {
						void host.app.workspace.openLinkText(note.sourceFile.path, host.sourceFile.path, 'tab');
					});
				} else {
					const sourcesButton = sourceCell.createEl('a', { text: `${notes.length} 个来源`, cls: 'related-operations-note-link' });
					sourcesButton.title = [...new Set(notes.map((item) => item.sourceFile.path))].join('\n');
					makeNoteLinkActivatable(sourcesButton, () => {
						void host.app.workspace.openLinkText(note.sourceFile.path, host.sourceFile.path, 'tab');
					});
				}
				previousSource = note.sourceFile.path;
			} else if (note.sourceFile.path !== previousSource) {
				const sourceCell = row.createEl('td');
				let rowSpan = 1;
				while (displayRows[index + rowSpan]?.[0]?.sourceFile.path === note.sourceFile.path) rowSpan++;
				sourceCell.rowSpan = rowSpan;
				const sourceLink = sourceCell.createEl('a', {
					text: note.sourceFile.basename,
					cls: 'related-operations-note-link',
				});
				sourceLink.title = note.sourceFile.path;
				makeNoteLinkActivatable(sourceLink, () => {
					void host.app.workspace.openLinkText(note.sourceFile.path, host.sourceFile.path, 'tab');
				});
				previousSource = note.sourceFile.path;
			}
		}
		const nameCell = row.createEl('td');
		const link = nameCell.createEl('a', { text: note.file.basename, cls: 'related-operations-note-link' });
		link.title = note.file.path;
		makeNoteLinkActivatable(link, () => {
			void host.app.workspace.openLinkText(note.file.path, host.sourceFile.path, 'tab');
		});
		row.createEl('td', { text: note.file.path, cls: 'related-operations-path' });
		if (host.merging()) {
			const relationCell = row.createEl('td', { cls: 'related-operations-relation' });
			relationCell.createSpan({
				text: host.showSourceColumn ? mergedRelationLabel(notes) : relationExplanation(note),
				cls: 'related-operations-relation-main',
			});
			relationCell.title = notes.map((item) => `${item.sourceFile.path}：${relationExplanation(item)}`).join('\n');
			const detail = mergedRelationDetail(notes);
			if (detail.length > 1 && new Set(detail.map((item) => item.label)).size > 1) {
				const detailText = detail.map((item) => `${item.name}：${item.label}`).join(' · ');
				const detailEl = relationCell.createSpan({ text: detailText, cls: 'related-operations-relation-detail' });
				detailEl.title = detail.map((item) => `${item.path}：${item.label}`).join('\n');
			}
		} else {
			const relationCell = row.createEl('td', {
				text: host.showSourceColumn ? relationLabel(note.relation) : relationExplanation(note),
				cls: 'related-operations-relation',
			});
			relationCell.title = relationExplanation(note);
		}
		row.createEl('td', { text: destinationFor(note.file, host.targetFolder()), cls: 'related-operations-path' });
	}
}
