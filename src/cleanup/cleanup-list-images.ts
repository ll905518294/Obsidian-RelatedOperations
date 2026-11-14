import { setIcon, TAbstractFile, TFile } from 'obsidian';
import type { CleanupViewContext, ImageGrouping } from './cleanup-types';
import { byPath, formatBytes, openInSystemFolder, parentFolder } from './cleanup-actions';
import { ImagePreviewModal } from './cleanup-modals';
import { updateSelectionSummary } from './cleanup-list-actions';
import { associateCheckbox } from './cleanup-a11y';

export function renderImageGrid(host: CleanupViewContext, container: HTMLElement, items: TFile[], allItems: TFile[]) {
	const grid = container.createDiv({ cls: 'orphan-cleanup-grid' });
	for (const group of groupedItems(host, items)) {
		if (group.label) grid.createEl('h3', { text: `${group.label}（${group.items.length}）`, cls: 'orphan-cleanup-grid-group' });
		const cards = grid.createDiv({ cls: 'orphan-cleanup-grid-items' });
		for (const item of group.items) {
			if (item instanceof TFile) renderImageCard(host, cards, item, allItems);
		}
	}
}

export function renderImageCard(host: CleanupViewContext, container: HTMLElement, file: TFile, items: TFile[]) {
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
	const name = card.createEl('a', { text: file.name, cls: 'orphan-cleanup-image-name' });
	name.addEventListener('click', (event) => {
		event.preventDefault();
		void host.app.workspace.openLinkText(file.path, '', 'tab');
	});
	card.createSpan({ text: formatBytes(file.stat.size), cls: 'orphan-cleanup-image-size' });
	associateCheckbox(checkbox, [name]);
}

export function addGroupingControl(host: CleanupViewContext, container: HTMLElement) {
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

export function groupedItems(host: CleanupViewContext, items: TAbstractFile[]) {
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

export function renderItemRow(host: CleanupViewContext, body: HTMLElement, item: TAbstractFile) {
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
	associateCheckbox(checkbox, [link]);
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

export function addImagePreview(host: CleanupViewContext, row: HTMLElement, file: TFile) {
	const cell = row.createEl('td', { cls: 'orphan-cleanup-preview' });
	const preview = cell.createEl('img', { attr: { alt: `${file.name} 预览`, loading: 'lazy' } });
	preview.src = host.app.vault.getResourcePath(file);
	preview.title = '点击放大预览';
	preview.addEventListener('click', () => new ImagePreviewModal(host.app, [file], 0, (selectedFile) => host.trashPreviewImage(selectedFile)).open());
	preview.addEventListener('error', () => {
		preview.replaceWith(cell.createSpan({ text: '无法预览', cls: 'orphan-cleanup-preview-failed' }));
	});
}
