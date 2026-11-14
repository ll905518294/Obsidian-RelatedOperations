import type { CleanupViewContext } from './cleanup-types';
import { brokenLinkKey } from '../broken-image-links';
import { brokenNoteLinkKey } from '../broken-note-links';
import { nativeImageLinkKey } from '../native-image-links';
import { confirmCleanup, confirmCleanupDuplicates, confirmConvertLinks, confirmCreateNotes, confirmRemoveLinks, confirmRemoveNoteLinks } from './cleanup-flows';

export function renderActions(host: CleanupViewContext) {
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

export function updateSelectionSummary(host: CleanupViewContext, summary?: HTMLElement) {
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
