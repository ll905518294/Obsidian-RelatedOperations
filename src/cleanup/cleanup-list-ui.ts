import { setIcon, TAbstractFile, TFile, TFolder } from 'obsidian';
import type { OrphanCleanupPanel } from './cleanup-panel';
import { CLEANUP_PAGE_SIZE, type ImageGrouping } from './cleanup-types';
import { brokenLinkKey, type BrokenImageLink } from '../broken-image-links';
import { brokenNoteLinkKey, type BrokenNoteLink } from '../broken-note-links';
import { convertNativeImageLink, nativeImageLinkKey, type NativeImageLink } from '../native-image-links';
import type { DuplicateFileGroup } from '../duplicate-files';
import { byPath, formatBytes, isImageFile, locateBrokenLink, locateBrokenNoteLink, locateDuplicateReference, locateNativeLink, openFolderInVault, openInSystemFolder, parentFolder } from './cleanup-actions';
import { ImagePreviewModal } from './cleanup-modals';
import { addReportControls, confirmCleanup, confirmCleanupDuplicates, confirmConvertLinks, confirmCreateNotes, confirmRemoveLinks, confirmRemoveNoteLinks } from './cleanup-flows';
export function renderList(host: OrphanCleanupPanel) {
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

export function renderDuplicateGroups(host: OrphanCleanupPanel, container: HTMLElement, groups: DuplicateFileGroup[]) {
		for (const group of groups) {
			const section = container.createDiv({ cls: 'orphan-cleanup-duplicate-group' });
			const heading = section.createDiv({ cls: 'orphan-cleanup-duplicate-heading' });
			heading.createEl('h3', { text: `${group.files.length} 个文件 · ${formatBytes(group.size)}` });
			const groupPaths = group.files.map((file) => file.path);
			const selectGroup = heading.createEl('button', { text: '选择本组全部' });
			selectGroup.type = 'button';
			selectGroup.addEventListener('click', () => {
				const selected = groupPaths.every((path) => host.duplicateSelections.has(path));
				for (const path of groupPaths) selected ? host.duplicateSelections.delete(path) : host.duplicateSelections.add(path);
				for (const checkbox of Array.from(section.querySelectorAll<HTMLInputElement>('input[data-duplicate-path]'))) {
					if (groupPaths.includes(checkbox.dataset.duplicatePath ?? '')) checkbox.checked = !selected;
				}
				selectGroup.setText(selected ? '选择本组全部' : '取消本组选择');
				updateSelectionSummary(host);
			});
			selectGroup.setText(groupPaths.every((path) => host.duplicateSelections.has(path)) ? '取消本组选择' : '选择本组全部');
			section.createDiv({ text: `SHA-256：${group.hash}`, cls: 'orphan-cleanup-detail' });
			const table = section.createEl('table', { cls: 'orphan-cleanup-table orphan-cleanup-duplicate-table' });
			const header = table.createEl('thead').createEl('tr');
			for (const text of ['选择', '预览', '文件', '所在笔记', '所在文件夹', '状态', '操作']) header.createEl('th', { text });
			const body = table.createEl('tbody');
			const previewFile = group.files.find((file) => isImageFile(file.extension));
			for (const [index, file] of group.files.entries()) {
				const row = body.createEl('tr');
				const checkbox = row.createEl('td').createEl('input', { type: 'checkbox' });
				checkbox.dataset.duplicatePath = file.path;
				checkbox.checked = host.duplicateSelections.has(file.path);
				checkbox.setAttribute('aria-label', `选择 ${file.path}`);
				checkbox.addEventListener('change', () => {
					if (checkbox.checked) host.duplicateSelections.add(file.path);
					else host.duplicateSelections.delete(file.path);
					updateSelectionSummary(host);
				});
				if (index === 0) {
					const previewCell = row.createEl('td', { attr: { rowspan: String(group.files.length) } });
					if (previewFile) {
						const preview = previewCell.createEl('img', { attr: { alt: `${previewFile.path} 预览`, loading: 'lazy' }, cls: 'orphan-cleanup-duplicate-preview' });
						const target = host.app.vault.getAbstractFileByPath(previewFile.path);
						if (target instanceof TFile) preview.src = host.app.vault.getResourcePath(target);
						preview.title = '点击预览';
						preview.addEventListener('click', () => { if (target instanceof TFile) new ImagePreviewModal(host.app, [target], 0, async () => {}).open(); });
					} else previewCell.setText('无图片预览');
				}
				const fileCell = row.createEl('td', { cls: 'orphan-cleanup-path' });
				const link = fileCell.createEl('a', { text: file.path, cls: 'orphan-cleanup-link' });
				link.addEventListener('click', (event) => { event.preventDefault(); void host.app.workspace.openLinkText(file.path, '', 'tab'); });
				const notesCell = row.createEl('td', { cls: 'orphan-cleanup-detail' });
				if (file.referencingNotes.length) {
					for (const [index, note] of file.referencingNotes.entries()) {
						if (index) notesCell.appendText('、');
						const noteLink = notesCell.createEl('a', { text: note, cls: 'orphan-cleanup-link' });
						noteLink.addEventListener('click', (event) => { event.preventDefault(); void host.app.workspace.openLinkText(note, '', 'tab'); });
					}
				} else notesCell.setText('未发现引用');
				const folderCell = row.createEl('td', { cls: 'orphan-cleanup-detail' });
				const folderPath = parentFolder(file.path);
				if (!folderPath) folderCell.setText('根目录');
				else {
					const folderLink = folderCell.createEl('a', { text: folderPath, cls: 'orphan-cleanup-link' });
					folderLink.addEventListener('click', (event) => {
						event.preventDefault();
						const folder = host.app.vault.getAbstractFileByPath(folderPath);
						if (folder instanceof TFolder) openFolderInVault(host.app, folder);
					});
				}
				row.createEl('td', { text: `${file.extension.toUpperCase() || '无扩展名'} · ${file.referenced ? '已被引用' : '未发现引用'}`, cls: 'orphan-cleanup-detail' });
				const actions = row.createEl('td');
				const locate = actions.createEl('button', { cls: 'orphan-cleanup-icon-button' });
				setIcon(locate, 'locate-fixed'); locate.title = '在笔记中定位'; locate.setAttribute('aria-label', '在笔记中定位');
				locate.addEventListener('click', () => void locateDuplicateReference(host.app, file));
				if (isImageFile(file.extension)) {
					const clean = actions.createEl('button', { cls: 'orphan-cleanup-icon-button' });
					clean.disabled = host.scanningTabs.has('duplicates') || host.dirtyTabs.has('duplicates');
					setIcon(clean, 'eraser'); clean.title = '清理图片链接'; clean.setAttribute('aria-label', '清理图片链接');
					clean.addEventListener('click', () => void host.cleanDuplicateLinks(file));
					const remove = actions.createEl('button', { cls: 'orphan-cleanup-icon-button' });
					remove.disabled = host.scanningTabs.has('duplicates') || host.dirtyTabs.has('duplicates');
					setIcon(remove, 'trash-2'); remove.title = '删除图片'; remove.setAttribute('aria-label', '删除图片');
					remove.addEventListener('click', () => void host.deleteDuplicateFile(file));
				}
				const openFolder = actions.createEl('button', { cls: 'orphan-cleanup-icon-button' });
				setIcon(openFolder, 'folder-open'); openFolder.title = '打开所在文件夹'; openFolder.setAttribute('aria-label', '打开所在文件夹');
				openFolder.addEventListener('click', () => { const target = host.app.vault.getAbstractFileByPath(file.path); if (target) openInSystemFolder(host.app, target); });
			}
		}
}

export function addSelectionControls(
		container: HTMLElement,
		pageCount: number,
		totalCount: number,
		selectPage: () => void,
		selectAll: () => void,
		clearPage: () => void,
		clearAll: () => void,
		refreshPage: () => void,
		refreshAfterClear: () => void,
	) {
		const selectPageButton = container.createEl('button', { text: '全选当前页' });
		selectPageButton.disabled = pageCount === 0;
		selectPageButton.addEventListener('click', () => { selectPage(); refreshPage(); });
		const selectAllButton = container.createEl('button', { text: '全选全部' });
		selectAllButton.disabled = totalCount === 0;
		selectAllButton.addEventListener('click', () => { selectAll(); refreshPage(); });
		const clearPageButton = container.createEl('button', { text: '取消当前页选择' });
		clearPageButton.disabled = pageCount === 0;
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

export function pageFor(host: OrphanCleanupPanel, tab: string, total: number) {
		const last = Math.max(0, Math.ceil(total / CLEANUP_PAGE_SIZE) - 1);
		const page = Math.min(host.pages.get(tab) ?? 0, last);
		host.pages.set(tab, page);
		return page;
	}

export function renderPagination(container: HTMLElement, total: number, page: number, onChange: (page: number) => void) {
		const pageCount = Math.ceil(total / CLEANUP_PAGE_SIZE);
		if (total === 0) return;
		const pagination = container.createDiv({ cls: 'orphan-cleanup-pagination' });
		const previous = pagination.createEl('button', { text: '上一页' });
		previous.disabled = page === 0;
		previous.addEventListener('click', () => onChange(page - 1));
		pagination.createSpan({ text: `第 ${page + 1} / ${pageCount} 页（共 ${total} 项）` });
		const next = pagination.createEl('button', { text: '下一页' });
		next.disabled = page === pageCount - 1;
		next.addEventListener('click', () => onChange(page + 1));
	}

export function addRefreshControl(host: OrphanCleanupPanel, container: HTMLElement) {
		const refresh = container.createEl('button', { text: '刷新' });
		refresh.disabled = host.scanningTabs.has(host.activeTab);
		refresh.title = '刷新当前页面';
		refresh.addEventListener('click', () => void host.refreshCurrentTab());
	}

export function renderBrokenLinkList(host: OrphanCleanupPanel, container: HTMLElement, links: BrokenImageLink[]) {
		const table = container.createEl('table', { cls: 'orphan-cleanup-table' });
		const header = table.createEl('thead').createEl('tr');
		header.createEl('th', { text: '选择' });
		header.createEl('th', { text: '源笔记' });
		header.createEl('th', { text: '失效链接' });
		header.createEl('th', { text: '未解析目标' });
		header.createEl('th', { text: '操作' });
		const body = table.createEl('tbody');
		for (const link of links) renderBrokenLinkRow(host, body, link);
	}

export function renderNativeLinkList(host: OrphanCleanupPanel, container: HTMLElement, links: NativeImageLink[]) {
		const table = container.createEl('table', { cls: 'orphan-cleanup-table' });
		const header = table.createEl('thead').createEl('tr');
		for (const text of ['选择', '源笔记', '原生链接', '目标/状态', '操作']) header.createEl('th', { text });
		const body = table.createEl('tbody');
		for (const link of links) {
			const row = body.createEl('tr');
			const checkbox = row.createEl('td').createEl('input', { type: 'checkbox' });
			checkbox.checked = host.nativeSelections.has(nativeImageLinkKey(link));
			checkbox.setAttribute('aria-label', `选择 ${link.sourcePath} 中的原生图片链接`);
			checkbox.disabled = !convertNativeImageLink(link);
			checkbox.addEventListener('change', () => { if (checkbox.checked) host.nativeSelections.add(nativeImageLinkKey(link)); else host.nativeSelections.delete(nativeImageLinkKey(link)); updateSelectionSummary(host); });
			const sourceCell = row.createEl('td', { cls: 'orphan-cleanup-path' });
			const source = sourceCell.createEl('a', { text: link.sourcePath, cls: 'orphan-cleanup-link' });
			source.addEventListener('click', (event) => {
				event.preventDefault();
				void host.app.workspace.openLinkText(link.sourcePath, '', 'tab');
			});
			row.createEl('td', { text: link.original, cls: 'orphan-cleanup-detail' });
			row.createEl('td', {
				text: convertNativeImageLink(link) ?? link.reason ?? '未解析目标',
				cls: 'orphan-cleanup-detail',
			});
			const locate = row.createEl('td').createEl('button', { text: '定位' });
			locate.addEventListener('click', () => void locateNativeLink(host.app, link));
		}
	}

export function renderBrokenNoteLinkList(host: OrphanCleanupPanel, container: HTMLElement, links: BrokenNoteLink[]) {
		const table = container.createEl('table', { cls: 'orphan-cleanup-table' });
		const header = table.createEl('thead').createEl('tr');
		for (const text of ['选择', '源笔记', '失效链接', '未解析目标', '类型', '操作']) header.createEl('th', { text });
		const body = table.createEl('tbody');
		for (const item of links) {
			const row = body.createEl('tr');
			const checkbox = row.createEl('td').createEl('input', { type: 'checkbox' });
			checkbox.checked = host.noteLinkSelections.has(brokenNoteLinkKey(item));
			checkbox.setAttribute('aria-label', `选择 ${item.sourcePath} 中的失效笔记链接`);
			checkbox.addEventListener('change', () => { if (checkbox.checked) host.noteLinkSelections.add(brokenNoteLinkKey(item)); else host.noteLinkSelections.delete(brokenNoteLinkKey(item)); updateSelectionSummary(host); });
			const source = row.createEl('td').createEl('a', { text: item.sourcePath, cls: 'orphan-cleanup-link' });
			source.addEventListener('click', (event) => { event.preventDefault(); void host.app.workspace.openLinkText(item.sourcePath, '', 'tab'); });
			row.createEl('td', { text: item.original, cls: 'orphan-cleanup-detail' });
			row.createEl('td', { text: item.linkPath, cls: 'orphan-cleanup-detail' });
			row.createEl('td', { text: item.syntax, cls: 'orphan-cleanup-detail' });
			const actions = row.createEl('td');
			actions.createEl('button', { text: '定位' }).addEventListener('click', () => void locateBrokenNoteLink(host.app, item));
			actions.createEl('button', { text: '忽略' }).addEventListener('click', () => { host.candidates.brokenNoteLinks = host.candidates.brokenNoteLinks.filter((candidate) => brokenNoteLinkKey(candidate) !== brokenNoteLinkKey(item)); host.renderContents(); });
		}
	}

export function renderBrokenLinkRow(host: OrphanCleanupPanel, body: HTMLElement, link: BrokenImageLink) {
		const key = brokenLinkKey(link);
		const row = body.createEl('tr');
		const checkbox = row.createEl('td').createEl('input', { type: 'checkbox' });
		checkbox.checked = host.linkSelections.has(key);
		checkbox.setAttribute('aria-label', `选择 ${link.sourcePath} 中的失效图片链接`);
		checkbox.addEventListener('change', () => {
			if (checkbox.checked) host.linkSelections.add(key);
			else host.linkSelections.delete(key);
			updateSelectionSummary(host);
		});

		const sourceCell = row.createEl('td', { cls: 'orphan-cleanup-path' });
		const source = sourceCell.createEl('a', { text: link.sourcePath, cls: 'orphan-cleanup-link' });
		source.addEventListener('click', (event) => {
			event.preventDefault();
			void host.app.workspace.openLinkText(link.sourcePath, '', 'tab');
		});
		const linkCell = row.createEl('td', { cls: 'orphan-cleanup-detail' });
		linkCell.createEl('code', { text: link.original });
		row.createEl('td', { text: link.linkPath, cls: 'orphan-cleanup-detail' });
		const actionCell = row.createEl('td');
		const locate = actionCell.createEl('button', { text: '定位', cls: 'orphan-cleanup-locate' });
		locate.type = 'button';
		locate.title = '打开源笔记并选中此链接';
		locate.addEventListener('click', (event) => {
			event.preventDefault();
			void locateBrokenLink(host.app, link);
		});
	}

export function renderImageGrid(host: OrphanCleanupPanel, container: HTMLElement, items: TFile[], allItems: TFile[]) {
		const grid = container.createDiv({ cls: 'orphan-cleanup-grid' });
		for (const group of groupedItems(host, items)) {
			if (group.label) grid.createEl('h3', { text: `${group.label}（${group.items.length}）`, cls: 'orphan-cleanup-grid-group' });
			const cards = grid.createDiv({ cls: 'orphan-cleanup-grid-items' });
			for (const item of group.items) {
				if (item instanceof TFile) renderImageCard(host, cards, item, allItems);
			}
		}
	}

export function renderImageCard(host: OrphanCleanupPanel, container: HTMLElement, file: TFile, items: TFile[]) {
		const card = container.createDiv({ cls: 'orphan-cleanup-image-card' });
		card.dataset.path = file.path;
		const header = card.createDiv({ cls: 'orphan-cleanup-image-card-header' });
		const checkbox = header.createEl('input', { type: 'checkbox' });
		checkbox.checked = host.selections.has(file.path);
		checkbox.setAttribute('aria-label', `选择 ${file.name}`);
		checkbox.addEventListener('change', () => {
			if (checkbox.checked) host.selections.add(file.path);
			else host.selections.delete(file.path);
			updateSelectionSummary(host);
		});
		const deleteButton = header.createEl('button', { text: '删除', cls: 'orphan-cleanup-image-delete' });
		deleteButton.disabled = host.scanningTabs.has('images') || host.dirtyTabs.has('images');
		deleteButton.type = 'button';
		deleteButton.title = '移入回收站';
		deleteButton.addEventListener('click', () => void host.trashSingleImage(file));
		const openFolder = header.createEl('button', { cls: 'orphan-cleanup-open-folder' });
		openFolder.type = 'button';
		openFolder.title = '打开所在文件夹';
		openFolder.setAttribute('aria-label', '打开所在文件夹');
		setIcon(openFolder, 'folder-open');
		openFolder.addEventListener('click', () => openInSystemFolder(host.app, file));
		const preview = card.createEl('img', { attr: { alt: `${file.name} 预览`, loading: 'lazy' } });
		preview.src = host.app.vault.getResourcePath(file);
		preview.title = '点击预览';
		preview.addEventListener('click', () => new ImagePreviewModal(host.app, items, items.indexOf(file), (selectedFile) => host.trashPreviewImage(selectedFile)).open());
		preview.addEventListener('error', () => {
			preview.replaceWith(card.createSpan({ text: '无法预览', cls: 'orphan-cleanup-preview-failed' }));
		});
		card.createEl('a', { text: file.name, cls: 'orphan-cleanup-image-name' }).addEventListener('click', (event) => {
			event.preventDefault();
			void host.app.workspace.openLinkText(file.path, '', 'tab');
		});
		card.createSpan({ text: formatBytes(file.stat.size), cls: 'orphan-cleanup-image-size' });
	}

export function addGroupingControl(host: OrphanCleanupPanel, container: HTMLElement) {
		const label = container.createEl('label', { cls: 'orphan-cleanup-grouping' });
		label.createSpan({ text: '分组：' });
		const select = label.createEl('select');
		const grouping = host.activeTab === 'attachments' ? host.attachmentGrouping : host.imageGrouping;
		for (const [value, text] of [
			['none', '不分组'],
			['path', '按路径'],
			['extension', '按格式'],
		] as const) {
			const option = select.createEl('option', { text, value });
			option.selected = value === grouping;
		}
		select.addEventListener('change', () => {
			if (host.activeTab === 'attachments') host.attachmentGrouping = select.value as ImageGrouping;
			else host.imageGrouping = select.value as ImageGrouping;
			host.renderContents();
		});
	}

export function groupedItems(host: OrphanCleanupPanel, items: TAbstractFile[]) {
		const grouping = host.activeTab === 'attachments' ? host.attachmentGrouping : host.imageGrouping;
		if ((host.activeTab !== 'images' && host.activeTab !== 'attachments') || grouping === 'none') return [{ label: '', items }];
		const groups = new Map<string, TAbstractFile[]>();
		for (const item of items) {
			if (!(item instanceof TFile)) continue;
			const label = grouping === 'path' ? parentFolder(item.path) || '根目录' : `.${item.extension.toUpperCase()}`;
			const group = groups.get(label) ?? [];
			group.push(item);
			groups.set(label, group);
		}
		return [...groups.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([label, grouped]) => ({ label, items: grouped.sort(byPath) }));
	}

export function renderItemRow(host: OrphanCleanupPanel, body: HTMLElement, item: TAbstractFile) {
		const row = body.createEl('tr');
		const checkbox = row.createEl('td').createEl('input', { type: 'checkbox' });
		checkbox.checked = host.selections.has(item.path);
		checkbox.setAttribute('aria-label', `选择 ${item.path}`);
		checkbox.addEventListener('change', () => {
			if (checkbox.checked) host.selections.add(item.path);
			else host.selections.delete(item.path);
			updateSelectionSummary(host);
		});
		if (host.activeTab === 'images' && item instanceof TFile) addImagePreview(host, row, item);
		const pathCell = row.createEl('td', { cls: 'orphan-cleanup-path' });
		const link = pathCell.createEl('a', { text: item.path, cls: 'orphan-cleanup-link' });
		link.addEventListener('click', (event) => {
			event.preventDefault();
			void host.app.workspace.openLinkText(item.path, '', 'tab');
		});
		row.createEl('td', {
			text: item instanceof TFile ? (host.activeTab === 'attachments' ? `${item.extension.toUpperCase()} · ${formatBytes(item.stat.size)}` : formatBytes(item.stat.size)) : '仅包含空子文件夹或没有子项',
			cls: 'orphan-cleanup-detail',
		});
		const actions = row.createEl('td');
		const openFolder = actions.createEl('button', { cls: 'orphan-cleanup-open-folder' });
		openFolder.type = 'button';
		openFolder.title = '打开所在文件夹';
		openFolder.setAttribute('aria-label', '打开所在文件夹');
		setIcon(openFolder, 'folder-open');
		openFolder.addEventListener('click', () => openInSystemFolder(host.app, item));
	}

export function addImagePreview(host: OrphanCleanupPanel, row: HTMLElement, file: TFile) {
		const cell = row.createEl('td', { cls: 'orphan-cleanup-preview' });
		const preview = cell.createEl('img', { attr: { alt: `${file.name} 预览`, loading: 'lazy' } });
		preview.src = host.app.vault.getResourcePath(file);
		preview.title = '点击放大预览';
		preview.addEventListener('click', () => new ImagePreviewModal(host.app, [file], 0, (selectedFile) => host.trashPreviewImage(selectedFile)).open());
		preview.addEventListener('error', () => {
			preview.replaceWith(cell.createSpan({ text: '无法预览', cls: 'orphan-cleanup-preview-failed' }));
		});
	}

export function renderActions(host: OrphanCleanupPanel) {
		const actions = host.contentEl.createDiv({ cls: 'orphan-cleanup-actions' });
		const summary = actions.createSpan({ cls: 'orphan-cleanup-summary' });
		summary.setAttribute('aria-live', 'polite');
		updateSelectionSummary(host, summary);
		const isLinkTab = host.activeTab === 'broken-links' || host.activeTab === 'native-links' || host.activeTab === 'broken-note-links';
		const cleanup = actions.createEl('button', {
			text: host.activeTab === 'native-links' ? '转换选中链接' : host.activeTab === 'broken-note-links' ? '创建选中笔记' : isLinkTab ? '移除选中链接' : host.activeTab === 'duplicates' ? '删除选中文件' : '移入回收站',
			cls: 'mod-cta',
		});
		cleanup.disabled = host.activeTab === 'broken-links' ? host.linkSelections.size === 0 : host.activeTab === 'native-links' ? host.nativeSelections.size === 0 : host.activeTab === 'broken-note-links' ? host.noteLinkSelections.size === 0 : host.activeTab === 'duplicates' ? host.duplicateSelections.size === 0 : host.selections.size === 0;
		cleanup.addEventListener('click', () => void (host.activeTab === 'native-links' ? confirmConvertLinks(host) : host.activeTab === 'broken-note-links' ? confirmCreateNotes(host) : isLinkTab ? confirmRemoveLinks(host) : host.activeTab === 'duplicates' ? confirmCleanupDuplicates(host) : confirmCleanup(host)));
		if (host.activeTab === 'broken-note-links') {
			const remove = actions.createEl('button', { text: '移除选中链接', cls: 'orphan-cleanup-remove-note-links' });
			remove.disabled = host.noteLinkSelections.size === 0;
			remove.addEventListener('click', () => void confirmRemoveNoteLinks(host));
		}
		if (host.scanningTabs.has(host.activeTab) || host.dirtyTabs.has(host.activeTab)) {
			for (const button of Array.from(actions.querySelectorAll<HTMLButtonElement>('button'))) button.disabled = true;
		}
	}

export function updateSelectionSummary(host: OrphanCleanupPanel, summary?: HTMLElement) {
		const target = summary ?? host.contentEl.querySelector<HTMLElement>('.orphan-cleanup-summary');
		if (!target) return;
		const images = host.candidates.images.filter((item) => host.selections.has(item.path)).length;
		const attachments = host.candidates.attachments.filter((item) => host.selections.has(item.path)).length;
		const emptyFiles = host.candidates.emptyFiles.filter((item) => host.selections.has(item.path)).length;
		const folders = host.candidates.folders.filter((item) => host.selections.has(item.path)).length;
		const links = host.candidates.brokenLinks.filter((item) => host.linkSelections.has(brokenLinkKey(item))).length;
		const native = host.candidates.nativeLinks.filter((item) => host.nativeSelections.has(nativeImageLinkKey(item))).length;
		const noteLinks = host.candidates.brokenNoteLinks.filter((item) => host.noteLinkSelections.has(brokenNoteLinkKey(item))).length;
		const duplicates = host.duplicateSelections.size;
		if (host.activeTab === 'duplicates') {
			target.setText(`已选：${duplicates} 个文件`);
		} else {
			target.setText(`已选：${images} 张图片，${attachments} 个附件，${emptyFiles} 个空文件，${links + native + noteLinks} 条链接，${folders} 个文件夹`);
		}
		const action = host.contentEl.querySelector<HTMLButtonElement>('.orphan-cleanup-actions button.mod-cta');
		if (action) action.disabled = host.activeTab === 'broken-links' ? links === 0 : host.activeTab === 'native-links' ? native === 0 : host.activeTab === 'broken-note-links' ? noteLinks === 0 : host.activeTab === 'duplicates' ? duplicates === 0 : images + attachments + emptyFiles + folders === 0;
		const removeNoteLinks = host.contentEl.querySelector<HTMLButtonElement>('.orphan-cleanup-remove-note-links');
		if (removeNoteLinks) removeNoteLinks.disabled = noteLinks === 0;
		if (host.scanningTabs.has(host.activeTab) || host.dirtyTabs.has(host.activeTab)) {
			if (action) action.disabled = true;
			if (removeNoteLinks) removeNoteLinks.disabled = true;
		}
	}

export function itemsForActiveTab(host: OrphanCleanupPanel): TAbstractFile[] {
		return host.activeTab === 'images' ? host.candidates.images : host.activeTab === 'attachments' ? host.candidates.attachments : host.activeTab === 'empty-files' ? host.candidates.emptyFiles : host.candidates.folders;
	}
