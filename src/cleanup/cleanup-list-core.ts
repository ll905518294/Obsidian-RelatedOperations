import { TAbstractFile, TFile } from 'obsidian';
import type { CleanupViewContext } from './cleanup-types';
import { CLEANUP_PAGE_SIZE } from './cleanup-types';
import { brokenLinkKey } from '../broken-image-links';
import { brokenNoteLinkKey } from '../broken-note-links';
import { convertNativeImageLink, nativeImageLinkKey } from '../native-image-links';
import { convertWikiNoteLink, wikiNoteLinkKey } from '../wiki-note-links';
import { addReportControls } from './cleanup-flows';
import { clampPageIndex, pageCount } from './cleanup-selectors';
import { addGroupingControl, groupedItems, renderImageGrid, renderItemRow } from './cleanup-list-images';
import { renderBrokenLinkList, renderBrokenNoteLinkList, renderNativeLinkList, renderWikiLinkList } from './cleanup-list-links';
import { renderDuplicateGroups } from './cleanup-list-duplicates';
import { updateSelectionSummary } from './cleanup-list-actions';
import { createColumnHeader } from './cleanup-a11y';

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

	if (currentTab === 'broken-links' || currentTab === 'native-links' || currentTab === 'broken-note-links' || currentTab === 'wiki-links') {
		const native = currentTab === 'native-links';
		const note = currentTab === 'broken-note-links';
		const wiki = currentTab === 'wiki-links';
		if (note) {
			renderLinkTab(host, toolbar, content, host.candidates.brokenNoteLinks, host.noteLinkSelections, brokenNoteLinkKey, '没有发现失效笔记链接。', (items) => renderBrokenNoteLinkList(host, content, items));
		} else if (native) {
			renderLinkTab(host, toolbar, content, host.candidates.nativeLinks, host.nativeSelections, nativeImageLinkKey, '没有发现原生图片链接。', (items) => renderNativeLinkList(host, content, items), (item) => Boolean(convertNativeImageLink(item)));
		} else if (wiki) {
			renderLinkTab(host, toolbar, content, host.candidates.wikiLinks, host.wikiSelections, wikiNoteLinkKey, '没有发现 Wiki 笔记链接。', (items) => renderWikiLinkList(host, content, items), (item) => Boolean(convertWikiNoteLink(item)));
		} else {
			renderLinkTab(host, toolbar, content, host.candidates.brokenLinks, host.linkSelections, brokenLinkKey, '没有发现失效图片链接。', (items) => renderBrokenLinkList(host, content, items));
		}
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
	createColumnHeader(header, '选择');
	if (host.activeTab === 'images') createColumnHeader(header, '预览');
	createColumnHeader(header, host.activeTab === 'images' ? '图片' : host.activeTab === 'empty-files' ? '文件' : host.activeTab === 'attachments' ? '附件' : '文件夹');
	createColumnHeader(header, host.activeTab === 'images' || host.activeTab === 'attachments' ? '大小' : host.activeTab === 'empty-files' ? '大小' : '说明');
	createColumnHeader(header, '操作');
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

function addSelectionControls(
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
	const more = moreMenu(container);
	const clearPageButton = more.createEl('button', { text: '取消当前页选择' });
	clearPageButton.disabled = pageCountValue === 0;
	clearPageButton.addEventListener('click', () => { clearPage(); refreshAfterClear(); });
	const clearAllButton = more.createEl('button', { text: '取消全部选择' });
	clearAllButton.disabled = totalCount === 0;
	clearAllButton.addEventListener('click', () => { clearAll(); refreshAfterClear(); });
}

/** 顶部工具栏的低频按钮折叠区，用原生 details/summary 保证键盘可达且不依赖额外状态。 */
export function moreMenu(container: HTMLElement): HTMLElement {
	let details = container.querySelector<HTMLDetailsElement>('.orphan-cleanup-more');
	if (!details) {
		details = container.createEl('details', { cls: 'orphan-cleanup-more' });
		details.createEl('summary', { text: '更多' });
		details.createDiv({ cls: 'orphan-cleanup-more-items' });
	}
	return details.querySelector<HTMLElement>('.orphan-cleanup-more-items')!;
}

function renderLinkTab<T>(
	host: CleanupViewContext,
	toolbar: HTMLElement,
	content: HTMLElement,
	allItems: T[],
	selected: Set<string>,
	keyOf: (item: T) => string,
	emptyText: string,
	render: (items: T[]) => void,
	selectable?: (item: T) => boolean,
) {
	const page = pageFor(host, host.activeTab, allItems.length);
	const pageItems = allItems.slice(page * CLEANUP_PAGE_SIZE, (page + 1) * CLEANUP_PAGE_SIZE);
	addSelectionControls(toolbar, pageItems.length, allItems.length,
		() => pageItems.forEach((item) => selected.add(keyOf(item))),
		() => allItems.forEach((item) => { if (!selectable || selectable(item)) selected.add(keyOf(item)); }),
		() => pageItems.forEach((item) => selected.delete(keyOf(item))),
		() => selected.clear(),
		() => { syncPageCheckboxes(content, true); updateSelectionSummary(host); },
		() => { syncPageCheckboxes(content, false); updateSelectionSummary(host); });
	if (allItems.length === 0) {
		content.createEl('p', { text: emptyText, cls: 'orphan-cleanup-empty' });
		return;
	}
	render(pageItems);
	renderPagination(toolbar, allItems.length, page, (next) => { host.pages.set(host.activeTab, next); host.renderContents(); });
}

function syncPageCheckboxes(list: HTMLElement, checked: boolean): void {
	for (const checkbox of Array.from(list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
		if (!checkbox.disabled) checkbox.checked = checked;
	}
}

function pageFor(host: CleanupViewContext, tab: string, total: number): number {
	const page = clampPageIndex(host.pages.get(tab) ?? 0, total, CLEANUP_PAGE_SIZE);
	host.pages.set(tab, page);
	return page;
}

function renderPagination(container: HTMLElement, total: number, page: number, onChange: (page: number) => void): void {
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

function addRefreshControl(host: CleanupViewContext, container: HTMLElement): void {
	const refresh = container.createEl('button', { text: '刷新' });
	refresh.disabled = host.scanningTabs.has(host.activeTab);
	refresh.title = '刷新当前页面';
	refresh.addEventListener('click', () => void host.refreshCurrentTab());
}

function itemsForActiveTab(host: CleanupViewContext): TAbstractFile[] {
	return host.activeTab === 'images' ? host.candidates.images : host.activeTab === 'attachments' ? host.candidates.attachments : host.activeTab === 'empty-files' ? host.candidates.emptyFiles : host.candidates.folders;
}
