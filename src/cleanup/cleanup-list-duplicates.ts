import { MarkdownView, Notice, setIcon, TFile, TFolder } from 'obsidian';
import type { CleanupViewContext } from './cleanup-types';
import type { DuplicateFileGroup } from '../duplicate-files';
import { formatBytes, isImageFile, openFolderInVault, openInSystemFolder, parentFolder, reasonFor } from './cleanup-actions';
import { ImagePreviewModal } from './cleanup-modals';
import { updateSelectionSummary } from './cleanup-list-actions';
import { applyRovingTabindex, associateCheckbox, createColumnHeader, makePreviewTrigger } from './cleanup-a11y';
import { requireSecondClick } from './cleanup-confirm-button';

export function renderDuplicateGroups(host: CleanupViewContext, container: HTMLElement, groups: DuplicateFileGroup[]) {
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
		for (const text of ['选择', '预览', '文件', '所在笔记', '所在文件夹', '状态', '操作']) createColumnHeader(header, text);
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
					makePreviewTrigger(preview, `预览 ${previewFile.path}`, () => { if (target instanceof TFile) new ImagePreviewModal(host.app, [target], 0).open(); });
				} else previewCell.setText('无图片预览');
			}
			const fileCell = row.createEl('td', { cls: 'orphan-cleanup-path' });
			const link = fileCell.createEl('a', { text: file.path, cls: 'orphan-cleanup-link' });
			link.addEventListener('click', (event) => { event.preventDefault(); void host.app.workspace.openLinkText(file.path, '', 'tab'); });
			associateCheckbox(checkbox, [link]);
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
				requireSecondClick(remove, () => host.deleteDuplicateFile(file), {
					onError: (error) => new Notice(`删除失败：${reasonFor(error)}`),
				});
			}
			const openFolder = actions.createEl('button', { cls: 'orphan-cleanup-icon-button' });
			setIcon(openFolder, 'folder-open'); openFolder.title = '打开所在文件夹'; openFolder.setAttribute('aria-label', '打开所在文件夹');
			openFolder.addEventListener('click', () => { const target = host.app.vault.getAbstractFileByPath(file.path); if (target) openInSystemFolder(host.app, target); });
		}
	}
	// 每个重复组只有一张预览图，整页预览图共用一个 Tab 停靠点。
	applyRovingTabindex(container, '.orphan-cleanup-duplicate-preview');
}

async function locateDuplicateReference(owner: CleanupViewContext['app'], file: DuplicateFileGroup['files'][number]) {
	const note = file.referencingNotes[0];
	if (!note) { new Notice('没有找到引用此文件的笔记。'); return; }
	await owner.workspace.openLinkText(note, '', false, { state: { mode: 'source' } });
	const view = owner.workspace.getActiveViewOfType(MarkdownView);
	if (!view?.file || view.file.path !== note) { new Notice(`已打开引用笔记：${note}`); return; }
	const cache = owner.metadataCache.getFileCache(view.file);
	const reference = [...cache?.embeds ?? [], ...cache?.links ?? []].find((item) => {
		if (!item.original.startsWith('!')) return false;
		return owner.metadataCache.getFirstLinkpathDest(item.link.split('#', 1)[0] ?? '', note)?.path === file.path;
	});
	if (!reference) { new Notice(`已打开引用笔记：${note}`); return; }
	const from = view.editor.offsetToPos(reference.position.start.offset);
	const to = view.editor.offsetToPos(reference.position.end.offset);
	view.editor.setSelection(from, to);
	view.editor.scrollIntoView({ from, to }, true);
	new Notice(`已在笔记中定位：${note}`);
}
