import { Notice } from 'obsidian';
import type { CleanupViewContext } from './cleanup-types';
import { brokenLinkKey } from '../broken-image-links';
import { brokenNoteLinkKey } from '../broken-note-links';
import { nativeImageLinkKey } from '../native-image-links';
import { wikiNoteLinkKey } from '../wiki-note-links';
import { confirmCleanup, confirmCleanupDuplicates, confirmConvertLinks, confirmConvertWikiLinks, confirmCreateNotes, confirmRemoveLinks, confirmRemoveNoteLinks } from './cleanup-flows';
import { requireSecondClick, resetArmedConfirmButtons } from './cleanup-confirm-button';
import { reasonFor } from './cleanup-actions';

export function renderActions(host: CleanupViewContext) {
	const actions = host.contentEl.createDiv({ cls: 'orphan-cleanup-actions' });
	const summary = actions.createSpan({ cls: 'orphan-cleanup-summary' });
	summary.setAttribute('aria-live', 'polite');
	updateSelectionSummary(host, summary);
	const isLinkTab = host.activeTab === 'broken-links' || host.activeTab === 'native-links' || host.activeTab === 'broken-note-links';
	const cleanup = actions.createEl('button', {
		text: host.activeTab === 'native-links' || host.activeTab === 'wiki-links' ? '转换选中链接' : host.activeTab === 'broken-note-links' ? '创建选中笔记' : isLinkTab ? '移除选中链接' : host.activeTab === 'duplicates' ? '删除选中文件' : '移入回收站',
		cls: 'mod-cta',
	});
	cleanup.disabled = host.activeTab === 'broken-links' ? host.linkSelections.size === 0 : host.activeTab === 'native-links' ? host.nativeSelections.size === 0 : host.activeTab === 'broken-note-links' ? host.noteLinkSelections.size === 0 : host.activeTab === 'wiki-links' ? host.wikiSelections.size === 0 : host.activeTab === 'duplicates' ? host.duplicateSelections.size === 0 : host.selections.size === 0;
	if (isLinkTab || host.activeTab === 'broken-note-links') {
		cleanup.addEventListener('click', () => void (host.activeTab === 'native-links' ? confirmConvertLinks(host) : host.activeTab === 'broken-note-links' ? confirmCreateNotes(host) : confirmRemoveLinks(host)));
	} else if (host.activeTab === 'wiki-links') {
		cleanup.addEventListener('click', () => void confirmConvertWikiLinks(host));
	} else {
		// File deletion needs a second click on the armed button; link and note
		// actions keep their own confirmation modals.
		requireSecondClick(cleanup, () => host.activeTab === 'duplicates' ? confirmCleanupDuplicates(host) : confirmCleanup(host), {
			onError: (error) => new Notice(`操作失败：${reasonFor(error)}`),
		});
	}
	if (host.activeTab === 'broken-note-links') {
		const remove = actions.createEl('button', { text: '移除选中链接', cls: 'orphan-cleanup-remove-note-links' });
		remove.disabled = host.noteLinkSelections.size === 0;
		remove.addEventListener('click', () => void confirmRemoveNoteLinks(host));
	}
	if (host.scanningTabs.has(host.activeTab) || host.dirtyTabs.has(host.activeTab)) {
		for (const button of Array.from(actions.querySelectorAll<HTMLButtonElement>('button'))) button.disabled = true;
	}
}

export function updateSelectionSummary(host: CleanupViewContext, summary?: HTMLElement) {
	const target = summary ?? host.contentEl.querySelector<HTMLElement>('.orphan-cleanup-summary');
	if (!target) return;
	resetArmedConfirmButtons(host.contentEl);
	const images = host.candidates.images.filter((item) => host.selections.has(item.path)).length;
	const attachments = host.candidates.attachments.filter((item) => host.selections.has(item.path)).length;
	const emptyFiles = host.candidates.emptyFiles.filter((item) => host.selections.has(item.path)).length;
	const folders = host.candidates.folders.filter((item) => host.selections.has(item.path)).length;
	const links = host.candidates.brokenLinks.filter((item) => host.linkSelections.has(brokenLinkKey(item))).length;
	const native = host.candidates.nativeLinks.filter((item) => host.nativeSelections.has(nativeImageLinkKey(item))).length;
	const noteLinks = host.candidates.brokenNoteLinks.filter((item) => host.noteLinkSelections.has(brokenNoteLinkKey(item))).length;
	const wikiLinks = host.candidates.wikiLinks.filter((item) => host.wikiSelections.has(wikiNoteLinkKey(item))).length;
	const duplicates = host.duplicateSelections.size;
	if (host.activeTab === 'duplicates') {
		target.setText(`已选：${duplicates} 个文件`);
	} else {
		target.setText(`已选：${images} 张图片，${attachments} 个附件，${emptyFiles} 个空文件，${links + native + noteLinks} 条链接，${wikiLinks} 条 Wiki 链接，${folders} 个文件夹`);
	}
	const action = host.contentEl.querySelector<HTMLButtonElement>('.orphan-cleanup-actions button.mod-cta');
	if (action) action.disabled = host.activeTab === 'broken-links' ? links === 0 : host.activeTab === 'native-links' ? native === 0 : host.activeTab === 'broken-note-links' ? noteLinks === 0 : host.activeTab === 'wiki-links' ? wikiLinks === 0 : host.activeTab === 'duplicates' ? duplicates === 0 : images + attachments + emptyFiles + folders === 0;
	const removeNoteLinks = host.contentEl.querySelector<HTMLButtonElement>('.orphan-cleanup-remove-note-links');
	if (removeNoteLinks) removeNoteLinks.disabled = noteLinks === 0;
	if (host.scanningTabs.has(host.activeTab) || host.dirtyTabs.has(host.activeTab)) {
		if (action) action.disabled = true;
		if (removeNoteLinks) removeNoteLinks.disabled = true;
	}
}
