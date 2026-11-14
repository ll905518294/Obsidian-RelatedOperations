import { MarkdownView, Notice } from 'obsidian';
import type { CleanupViewContext } from './cleanup-types';
import { brokenLinkKey, findBrokenLinkOffset, type BrokenImageLink } from '../broken-image-links';
import { brokenNoteLinkKey, findBrokenNoteLinkOffset, type BrokenNoteLink } from '../broken-note-links';
import { convertNativeImageLink, nativeImageLinkKey, nativeImageLinkOffset, type NativeImageLink } from '../native-image-links';
import { updateSelectionSummary } from './cleanup-list-actions';

export function renderBrokenLinkList(host: CleanupViewContext, container: HTMLElement, links: BrokenImageLink[]) {
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

export function renderNativeLinkList(host: CleanupViewContext, container: HTMLElement, links: NativeImageLink[]) {
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

export function renderBrokenNoteLinkList(host: CleanupViewContext, container: HTMLElement, links: BrokenNoteLink[]) {
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

export function renderBrokenLinkRow(host: CleanupViewContext, body: HTMLElement, link: BrokenImageLink) {
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

async function locateBrokenNoteLink(owner: CleanupViewContext['app'], link: BrokenNoteLink) {
	await owner.workspace.openLinkText(link.sourcePath, '', false, { state: { mode: 'source' } });
	const view = owner.workspace.getActiveViewOfType(MarkdownView);
	if (!view) return;
	const range = findBrokenNoteLinkOffset(view.editor.getValue(), link);
	if (!range) { new Notice('笔记内容已变化，请重新扫描。'); return; }
	const from = view.editor.offsetToPos(range.start); const to = view.editor.offsetToPos(range.end);
	view.editor.setSelection(from, to); view.editor.scrollIntoView({ from, to }, true);
}

async function locateNativeLink(owner: CleanupViewContext['app'], link: NativeImageLink) {
	await owner.workspace.openLinkText(link.sourcePath, '', false, { state: { mode: 'source' } });
	const view = owner.workspace.getActiveViewOfType(MarkdownView);
	if (!view) return;
	const range = nativeImageLinkOffset(view.editor.getValue(), link);
	if (!range) { new Notice('笔记内容已变化，请重新扫描。'); return; }
	const from = view.editor.offsetToPos(range.start); const to = view.editor.offsetToPos(range.end);
	view.editor.setSelection(from, to); view.editor.scrollIntoView({ from, to }, true);
}

async function locateBrokenLink(owner: CleanupViewContext['app'], link: BrokenImageLink) {
	await owner.workspace.openLinkText(link.sourcePath, '', false, { state: { mode: 'source' } });
	const activeView = owner.workspace.getActiveViewOfType(MarkdownView);
	let view = activeView?.file?.path === link.sourcePath ? activeView : null;
	if (!view) {
		for (const leaf of owner.workspace.getLeavesOfType('markdown')) {
			const markdownView = leaf.view;
			if (markdownView instanceof MarkdownView && markdownView.file?.path === link.sourcePath) {
				await owner.workspace.revealLeaf(leaf);
				view = markdownView;
				break;
			}
		}
	}
	if (!view) {
		new Notice('无法打开源笔记。');
		return;
	}

	const editor = view.editor;
	const range = findBrokenLinkOffset(editor.getValue(), link);
	if (!range) {
		new Notice('笔记内容已变化，请重新扫描。');
		return;
	}
	const from = editor.offsetToPos(range.start);
	const to = editor.offsetToPos(range.end);
	editor.setSelection(from, to);
	editor.scrollIntoView({ from, to }, true);
}
