import { TAbstractFile, TFile } from 'obsidian';
import type { CleanupViewContext } from './cleanup-types';
import { CLEANUP_PAGE_SIZE } from './cleanup-types';
import { brokenLinkKey } from '../broken-image-links';
import { brokenNoteLinkKey, type BrokenNoteLink } from '../broken-note-links';
import { convertNativeImageLink, nativeImageLinkKey } from '../native-image-links';
import { addReportControls } from './cleanup-flows';
import { clampPageIndex, pageCount } from './cleanup-selectors';
import { addGroupingControl, groupedItems, renderImageGrid, renderItemRow } from './cleanup-list-images';
import { renderBrokenLinkList, renderBrokenNoteLinkList, renderNativeLinkList } from './cleanup-list-links';
import { renderDuplicateGroups } from './cleanup-list-duplicates';
import { updateSelectionSummary } from './cleanup-list-actions';

export function renderList(host: CleanupViewContext) {
	const currentTab = host.activeTab;
	const list = host.contentEl.createDiv({ cls: 'orphan-cleanup-list' });
	const toolbar = list.createDiv({ cls: 'orphan-cleanup-toolbar' });
	const content = list.createDiv({ cls: 'orphan-cleanup-scroll' });
	if (host.scanningTabs.has(currentTab) || host.dirtyTabs.has(currentTab)) {
		const status = content.createDiv({ cls: 'orphan-cleanup-refresh-status', text: host.scanningTabs.has(currentTab)
			? '正在复核此分类，暂时展示已有结果；你可以继续切换标签页。'
			: '结果待复核，请刷新后再处理。' });
		status.setAttribute('role', 'status');
	}
	addRefreshControl(host, toolbar);
	addReportControls(host, toolbar);
	if (currentTab === 'duplicates') {
		if (host.candidates.duplicateWarnings.length) {
			content.createDiv({ text: `有 ${host.candidates.duplicateWarnings.length} 个文件读取失败，仅展示成功计算哈希的结果。`, cls: 'orphan-cleanup-warning' });
		}
		const allDuplicates = host.candidates.duplicates.flatMap((group) => group.files.map((file) => file.path));
		const page = pageFor(host, currentTab, host.candidates.duplicates.length);
		const pageItems = host.candidates.duplicates.slice(page * CLEANUP_PAGE_SIZE, (page + 1) * CLEANUP_PAGE_SIZE);
		const allPageFiles = pageItems.flatMap((group) => group.files.map((file) => file.path));
		addSelectionControls(toolbar, allPageFiles.length, allDuplicates.length,
			() => allPageFiles.forEach((path) => host.duplicateSelections.add(path)),
			() => allDuplicates.forEach((path) => host.duplicateSelections.add(path)),
			() => allPageFiles.forEach((path) => host.duplicateSelections.delete(path)),
			() => host.duplicateSelections.clear(),
		() => { syncPageCheckboxes(content, true); updateSelectionSummary(host); },
		() => { syncPageCheckboxes(content, false); updateSelectionSummary(host); });
		if (!pageItems.length) content.createEl('p', { text: '没有发现重复文件。', cls: 'orphan-cleanup-empty' });
		else renderDuplicateGroups(host, content, pageItems);
		renderPagination(toolbar, host.candidates.duplicates.length, page, (next) => { host.pages.set(currentTab, next); host.renderContents(); });
		return;
	}
	if (host.activeTab === 'images' || host.activeTab === 'attachments') addGroupingControl(host, toolbar);

	if (currentTab === 'broken-links' || currentTab === 'native-links' || currentTab === 'broken-note-links') {
		const native = currentTab === 'native-links';
		const note = currentTab === 'broken-note-links';
		const candidates = note ? host.candidates.brokenNoteLinks : native ? host.candidates.nativeLinks : host.candidates.brokenLinks;
		const page = pageFor(host, currentTab, candidates.length);
		const pageItems = candidates.slice(page * CLEANUP_PAGE_SIZE, (page + 1) * CLEANUP_PAGE_SIZE);
			addSelectionControls(toolbar, pageItems.length, candidates.length,
					() => pageItems.forEach((item) => { if (note) host.noteLinkSelections.add(brokenNoteLinkKey(item as unknown as BrokenNoteLink)); else if (native) host.nativeSelections.add(nativeImageLinkKey(item)); else host.linkSelections.add(brokenLinkKey(item)); }),
					() => candidates.forEach((item) => { if (note) host.noteLinkSelections.add(brokenNoteLinkKey(item as unknown as BrokenNoteLink)); else if (native) { if (convertNativeImageLink(item)) host.nativeSelections.add(nativeImageLinkKey(item)); } else host.linkSelections.add(brokenLinkKey(item)); }),
					() => pageItems.forEach((item) => { if (note) host.noteLinkSelections.delete(brokenNoteLinkKey(item as unknown as BrokenNoteLink)); else if (native) host.nativeSelections.delete(nativeImageLinkKey(item)); else host.linkSelections.delete(brokenLinkKey(item)); }),
			() => { if (note) host.noteLinkSelections.clear(); else if (native) host.nativeSelections.clear(); else host.linkSelections.clear(); },
			() => { syncPageCheckboxes(content, true); updateSelectionSummary(host); },
			() => { syncPageCheckboxes(content, false); updateSelectionSummary(host); });
		if (candidates.length === 0) {
			content.createEl('p', { text: note ? '没有发现失效笔记链接。' : native ? '没有发现原生图片链接。' : '没有发现失效图片链接。', cls: 'orphan-cleanup-empty' });
			return;
		}
			if (note) renderBrokenNoteLinkList(host, content, pageItems as BrokenNoteLink[]); else native ? renderNativeLinkList(host, content, pageItems) : renderBrokenLinkList(host, content, pageItems);
		renderPagination(toolbar, candidates.length, page, (next) => { host.pages.set(currentTab, next); host.renderContents(); });
		return;
	}

	const items = itemsForActiveTab(host);
	const page = pageFor(host, currentTab, items.length);
	const pageItems = items.slice(page * CLEANUP_PAGE_SIZE, (page + 1) * CLEANUP_PAGE_SIZE);
	addSelectionControls(toolbar, pageItems.length, items.length,
		() => pageItems.forEach((item) => host.selections.add(item.path)),
		() => items.forEach((item) => host.selections.add(item.path)),
		() => pageItems.forEach((item) => host.selections.delete(item.path)),
		() => host.selections.clear(),
		() => { syncPageCheckboxes(content, true); updateSelectionSummary(host); },
		() => { syncPageCheckboxes(content, false); updateSelectionSummary(host); });

	if (items.length === 0) {
		content.createEl('p', {
			text: host.activeTab === 'images'
				? '没有发现未引用图片。'
				: host.activeTab === 'attachments'
					? '没有发现未引用附件。'
				: host.activeTab === 'empty-files'
					? '没有发现空文件。'
				: '没有发现可递归清理的空文件夹。',
			cls: 'orphan-cleanup-empty',
		});
		return;
	}

	if (currentTab === 'images') {
		renderImageGrid(host, content, pageItems.filter((item): item is TFile => item instanceof TFile), items as TFile[]);
		renderPagination(toolbar, items.length, page, (next) => { host.pages.set(currentTab, next); host.renderContents(); });
		return;
	}

	const table = content.createEl('table', { cls: 'orphan-cleanup-table' });
	const header = table.createEl('thead').createEl('tr');
	header.createEl('th', { text: '选择' });
	if (host.activeTab === 'images') header.createEl('th', { text: '预览' });
	header.createEl('th', { text: host.activeTab === 'images' ? '图片' : host.activeTab === 'empty-files' ? '文件' : host.activeTab === 'attachments' ? '附件' : '文件夹' });
	header.createEl('th', { text: host.activeTab === 'images' || host.activeTab === 'attachments' ? '大小' : host.activeTab === 'empty-files' ? '大小' : '说明' });
	header.createEl('th', { text: '操作' });
	const body = table.createEl('tbody');
	for (const group of groupedItems(host, pageItems)) {
		if (group.label) {
			const groupRow = body.createEl('tr', { cls: 'orphan-cleanup-group' });
			groupRow.createEl('td', { text: `${group.label}（${group.items.length}）`, attr: { colspan: host.activeTab === 'images' ? '5' : '4' } });
		}
		for (const item of group.items) renderItemRow(host, body, item);
	}
	renderPagination(toolbar, items.length, page, (next) => { host.pages.set(currentTab, next); host.renderContents(); });
}

export function addSelectionControls(
	container: HTMLElement,
	pageCountValue: number,
	totalCount: number,
	selectPage: () => void,
	selectAll: () => void,
	clearPage: () => void,
	clearAll: () => void,
	refreshPage: () => void,
	refreshAfterClear: () => void,
	) {
	const selectPageButton = container.createEl('button', { text: '全选当前页' });
	selectPageButton.disabled = pageCountValue === 0;
	selectPageButton.addEventListener('click', () => { selectPage(); refreshPage(); });
	const selectAllButton = container.createEl('button', { text: '全选全部' });
	selectAllButton.disabled = totalCount === 0;
	selectAllButton.addEventListener('click', () => { selectAll(); refreshPage(); });
	const clearPageButton = container.createEl('button', { text: '取消当前页选择' });
	clearPageButton.disabled = pageCountValue === 0;
	clearPageButton.addEventListener('click', () => { clearPage(); refreshAfterClear(); });
	const clearAllButton = container.createEl('button', { text: '取消全部选择' });
	clearAllButton.disabled = totalCount === 0;
	clearAllButton.addEventListener('click', () => { clearAll(); refreshAfterClear(); });
}

export function syncPageCheckboxes(list: HTMLElement, checked: boolean) {
	for (const checkbox of Array.from(list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
		if (!checkbox.disabled) checkbox.checked = checked;
	}
}

export function pageFor(host: CleanupViewContext, tab: string, total: number) {
	const page = clampPageIndex(host.pages.get(tab) ?? 0, total, CLEANUP_PAGE_SIZE);
	host.pages.set(tab, page);
	return page;
}

export function renderPagination(container: HTMLElement, total: number, page: number, onChange: (page: number) => void) {
	const pages = pageCount(total, CLEANUP_PAGE_SIZE);
	if (total === 0) return;
	const pagination = container.createDiv({ cls: 'orphan-cleanup-pagination' });
	const previous = pagination.createEl('button', { text: '上一页' });
	previous.disabled = page === 0;
	previous.addEventListener('click', () => onChange(page - 1));
	pagination.createSpan({ text: `第 ${page + 1} / ${pages} 页（共 ${total} 项）` });
	const next = pagination.createEl('button', { text: '下一页' });
	next.disabled = page === pages - 1;
	next.addEventListener('click', () => onChange(page + 1));
}

export function addRefreshControl(host: CleanupViewContext, container: HTMLElement) {
	const refresh = container.createEl('button', { text: '刷新' });
	refresh.disabled = host.scanningTabs.has(host.activeTab);
	refresh.title = '刷新当前页面';
	refresh.addEventListener('click', () => void host.refreshCurrentTab());
}

export function itemsForActiveTab(host: CleanupViewContext): TAbstractFile[] {
	return host.activeTab === 'images' ? host.candidates.images : host.activeTab === 'attachments' ? host.candidates.attachments : host.activeTab === 'empty-files' ? host.candidates.emptyFiles : host.candidates.folders;
}
