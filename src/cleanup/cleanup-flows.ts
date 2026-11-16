import { Notice, TFile, TFolder } from 'obsidian';
import type { NativeImageLink } from '../native-image-links';
import type { CleanupResult, CleanupViewContext } from './cleanup-types';
import { buildCleanupReport, type CleanupReportData } from '../cleanup-report';
import { selectCurrentCleanupItems } from '../cleanup-selection';
import { brokenLinkKey, removeSelectedBrokenLinks } from '../broken-image-links';
import { brokenNoteLinkKey, createMissingNotes, removeSelectedBrokenNoteLinks } from '../broken-note-links';
import { convertNativeImageLink, nativeImageLinkKey, replaceNativeImageLinks, revalidateNativeImageLink } from '../native-image-links';
import { replaceWikiNoteLinks, revalidateWikiNoteLink, wikiNoteLinkKey, type WikiNoteLink } from '../wiki-note-links';
import { planDuplicateDeletion, removeFileReferencesForFiles, revalidateDuplicateDeletion } from '../duplicate-files';
import { findCleanupCandidates } from './cleanup-scan';
import { reasonFor, trashSelected } from './cleanup-actions';
import { ConvertNativeLinksConfirmationModal, ConvertWikiLinksConfirmationModal, CreateNotesConfirmationModal, RemoveBrokenLinksConfirmationModal } from './cleanup-modals';
export function addReportControls(host: CleanupViewContext, container: HTMLElement): void {
		const data = buildReportData(host);
		const copy = container.createEl('button', { text: '复制报告' });
		copy.addEventListener('click', () => void copyReport(host));
		const exportButton = container.createEl('button', { text: '导出报告' });
		exportButton.addEventListener('click', () => void exportReport(host, buildCleanupReport(data)));
	}

function buildReportData(host: CleanupViewContext): CleanupReportData {
		return {
			generatedAt: new Date().toLocaleString('zh-CN'),
			images: host.candidates.images.map((item) => item.path),
			attachments: host.candidates.attachments.map((item) => item.path),
			emptyFiles: host.candidates.emptyFiles.map((item) => item.path),
			folders: host.candidates.folders.map((item) => item.path),
			brokenLinks: host.candidates.brokenLinks.map(({ sourcePath, original, linkPath }) => ({ sourcePath, original, linkPath })),
			nativeLinks: host.candidates.nativeLinks.map((item) => ({ sourcePath: item.sourcePath, original: item.original, status: convertNativeImageLink(item) ?? item.reason ?? '未解析目标' })),
			brokenNoteLinks: host.candidates.brokenNoteLinks.map(({ sourcePath, original, linkPath, syntax }) => ({ sourcePath, original, linkPath, syntax })),
			duplicates: host.candidates.duplicates,
			duplicateWarnings: host.candidates.duplicateWarnings,
			processed: host.processed,
		};
	}

async function copyReport(host: CleanupViewContext): Promise<void> {
		try {
			await navigator.clipboard.writeText(buildCleanupReport(buildReportData(host)));
			new Notice('报告已复制。');
		} catch (error) {
			new Notice(`复制报告失败：${reasonFor(error)}`);
		}
	}

async function exportReport(host: CleanupViewContext, content: string): Promise<void> {
		const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
		const base = `related-operations-report-${stamp}`;
		let path = `${base}.md`; let index = 2;
		while (host.app.vault.getAbstractFileByPath(path)) path = `${base}-${index++}.md`;
		try { await host.app.vault.create(path, content); new Notice(`报告已导出：${path}`); } catch (error) { new Notice(`导出报告失败：${reasonFor(error)}`); }
	}

function pruneDeletedCandidates(host: CleanupViewContext): void {
		const exists = (item: { path: string }) => !!host.app.vault.getAbstractFileByPath(item.path);
		for (const key of ['images', 'attachments', 'emptyFiles'] as const) host.candidates[key] = host.candidates[key].filter(exists);
		host.candidates.folders = host.candidates.folders.filter(exists);
		host.candidates.duplicates = host.candidates.duplicates.map((group) => ({ ...group, files: group.files.filter(exists) })).filter((group) => group.files.length > 1);
		const sourceExists = (link: { sourcePath: string }) => exists({ path: link.sourcePath });
		host.candidates.brokenLinks = host.candidates.brokenLinks.filter(sourceExists);
		host.candidates.nativeLinks = host.candidates.nativeLinks.filter(sourceExists);
		host.candidates.brokenNoteLinks = host.candidates.brokenNoteLinks.filter(sourceExists);
		host.candidates.wikiLinks = host.candidates.wikiLinks.filter(sourceExists);
		for (const selection of [host.selections, host.duplicateSelections]) {
			for (const path of selection) if (!exists({ path })) selection.delete(path);
		}
	}

export async function confirmCleanup(host: CleanupViewContext): Promise<void> {
		const selectedImages = host.candidates.images.filter((item) => host.selections.has(item.path));
		const selectedAttachments = host.candidates.attachments.filter((item) => host.selections.has(item.path));
		const selectedEmptyFiles = host.candidates.emptyFiles.filter((item) => host.selections.has(item.path));
		const selectedFolders = host.candidates.folders.filter((item) => host.selections.has(item.path));
		if (selectedImages.length + selectedAttachments.length + selectedEmptyFiles.length + selectedFolders.length === 0) return;
		let verified: { files: TFile[]; folders: TFolder[]; skipped: string[] };
		try {
			verified = await revalidateCleanupSelection(host, 
				[selectedImages, selectedAttachments, selectedEmptyFiles].flat().map((item) => item.path),
				selectedFolders.map((item) => item.path),
			);
		} catch (error) {
			new Notice(`重新确认清理条件失败：${reasonFor(error)}`);
			return;
		}
		const result = await trashSelected(host.app, verified.files, verified.folders);
		result.skipped.unshift(...verified.skipped);
		host.processed = { success: result.deleted.length, skipped: result.skipped.length, failed: result.failed };
		const message = [`已移入回收站：${result.deleted.length}`, `跳过：${result.skipped.length}`, `失败：${result.failed.length}`];
		if (result.skipped.length) message.push(`跳过文件：${result.skipped.join('、')}`);
		if (result.failed.length) message.push(result.failed.map((item) => `${item.path}（${item.reason}）`).join('、'));
		new Notice(message.join('\n'));
		pruneDeletedCandidates(host);
		await host.scanTab('folders');
		host.saveCacheToSettings();
		host.renderContents();
	}

export async function confirmCleanupDuplicates(host: CleanupViewContext): Promise<void> {
		const selectedFiles = host.candidates.duplicates.flatMap((group) => group.files.filter((file) => host.duplicateSelections.has(file.path)));
		if (selectedFiles.length === 0) return;
	const plan = await planDuplicateDeletion(host.app, host.candidates.duplicates, selectedFiles.map((file) => file.path));
	const skippedReasons = new Map(plan.skipped.map((item) => [item.path, item.reason]));
	const result: CleanupResult = { deleted: [], skipped: [...skippedReasons.keys()], failed: [] };
	if (plan.deletable.length) {
		const references = await removeFileReferencesForFiles(host.app, plan.deletable.map((file) => file.path));
		if (references.failed.length) {
			new Notice(`未删除文件：笔记链接清理失败（${references.failed.join('、')}）`);
			return;
		}
		// 清理引用会改写并重新保存笔记，这期间磁盘上的重复文件可能被其他编辑
		// 改写；按删除前的实际内容再校验一次，避免删掉已不再是重复内容的文件。
		const changed = await revalidateDuplicateDeletion(host.app, plan.verified);
		const changedPaths = new Set(changed.map((item) => item.path));
		for (const item of changed) {
			if (skippedReasons.has(item.path)) continue;
			skippedReasons.set(item.path, item.reason);
			result.skipped.push(item.path);
		}
		for (const file of plan.deletable) {
			if (changedPaths.has(file.path)) continue;
			const target = host.app.vault.getAbstractFileByPath(file.path);
			if (!(target instanceof TFile)) { result.skipped.push(file.path); continue; }
			try {
				await host.app.fileManager.trashFile(target);
				result.deleted.push(file.path);
			} catch (error) {
				result.failed.push({ path: file.path, reason: reasonFor(error) });
			}
		}
	}
	host.processed = { success: result.deleted.length, skipped: result.skipped.length, failed: result.failed };
	const message = [`已删除：${result.deleted.length}`, `跳过：${result.skipped.length}`, `失败：${result.failed.length}`];
	if (result.skipped.length) message.push(`跳过文件：${result.skipped.map((path) => skippedReasons.has(path) ? `${path}（${skippedReasons.get(path)}）` : path).join('、')}`);
	if (result.failed.length) message.push(result.failed.map((item) => `${item.path}（${item.reason}）`).join('、'));
	new Notice(message.join('\n'));
	if (result.deleted.length > 0 || result.failed.length > 0) {
		host.candidates.duplicates = host.candidates.duplicates.map((group) => ({ ...group, files: group.files.filter((f) => !result.deleted.includes(f.path)) })).filter((group) => group.files.length > 1);
	}
	host.duplicateSelections.clear();
	pruneDeletedCandidates(host);
	await host.scanTab('folders');
	host.saveCacheToSettings();
	host.renderContents();
}

export async function revalidateCleanupSelection(
	host: CleanupViewContext,
	filePaths: Iterable<string>,
	folderPaths: Iterable<string>,
): Promise<{ files: TFile[]; folders: TFolder[]; skipped: string[] }> {
		const current = await findCleanupCandidates(host.app, host.settings.orphanImageExtensions, host.settings.orphanIgnoredFolders, undefined, false);
		const files = selectCurrentCleanupItems(filePaths, [...current.images, ...current.attachments, ...current.emptyFiles]);
		const folders = selectCurrentCleanupItems(folderPaths, current.folders);
		return { files: files.items, folders: folders.items, skipped: [...files.skipped, ...folders.skipped] };
	}

export async function confirmRemoveLinks(host: CleanupViewContext): Promise<void> {
		if (host.activeTab === 'broken-note-links') return confirmRemoveNoteLinks(host);
		const selectedLinks = host.candidates.brokenLinks.filter((item) => host.linkSelections.has(brokenLinkKey(item)));
		if (selectedLinks.length === 0) return;
		const sourceCount = new Set(selectedLinks.map((item) => item.sourcePath)).size;
		const confirmed = await new RemoveBrokenLinksConfirmationModal(host.app, selectedLinks.length, sourceCount).waitForConfirmation();
		if (!confirmed) return;
		const result = await removeSelectedBrokenLinks(host.app, selectedLinks);
		host.processed = { success: result.removed, skipped: result.skipped, failed: result.failed };
		const message = [`已移除链接：${result.removed}`, `跳过：${result.skipped}`, `失败：${result.failed.length}`];
		if (result.failed.length) message.push(result.failed.map((item) => `${item.path}（${item.reason}）`).join('、'));
		new Notice(message.join('\n'));
		host.linkSelections.clear();
		host.renderContents();
	}

export async function confirmRemoveNoteLinks(host: CleanupViewContext): Promise<void> {
		const selected = host.candidates.brokenNoteLinks.filter((item) => host.noteLinkSelections.has(brokenNoteLinkKey(item)));
		if (!selected.length) return;
		const sourceCount = new Set(selected.map((item) => item.sourcePath)).size;
		if (!await new RemoveBrokenLinksConfirmationModal(host.app, selected.length, sourceCount).waitForConfirmation()) return;
		const result = await removeSelectedBrokenNoteLinks(host.app, selected);
		host.processed = { success: result.removed, skipped: result.skipped, failed: result.failed };
		new Notice(`已移除链接：${result.removed}，跳过：${result.skipped}，失败：${result.failed.length}`);
		host.noteLinkSelections.clear();
		host.renderContents();
	}

export async function confirmCreateNotes(host: CleanupViewContext): Promise<void> {
		const selected = host.candidates.brokenNoteLinks.filter((item) => host.noteLinkSelections.has(brokenNoteLinkKey(item)));
		if (!selected.length || !await new CreateNotesConfirmationModal(host.app, selected.length).waitForConfirmation()) return;
		const result = await createMissingNotes(host.app, selected);
		host.processed = { success: result.created.length, skipped: result.skipped.length, failed: result.failed };
		new Notice(`已创建：${result.created.length}，跳过：${result.skipped.length}，失败：${result.failed.length}`);
		await host.scanTab('broken-note-links');
		await host.scanTab('empty-files');
		await host.scanTab('folders');
		host.noteLinkSelections.clear();
		host.saveCacheToSettings();
		host.renderContents();
	}

export async function confirmConvertLinks(host: CleanupViewContext): Promise<void> {
		const selected = host.candidates.nativeLinks.filter((item) => host.nativeSelections.has(nativeImageLinkKey(item)));
		if (!selected.length) return;
		if (!await new ConvertNativeLinksConfirmationModal(host.app, selected.length).waitForConfirmation()) return;
		let converted = 0, skipped = 0, failed = 0;
		const failures: Array<{ path: string; reason: string }> = [];
		const currentLinks = selected.map((link) => revalidateNativeImageLink(host.app, link));
		const grouped = new Map<string, NativeImageLink[]>();
		for (const link of currentLinks) {
			const list = grouped.get(link.sourcePath) ?? [];
			list.push(link);
			grouped.set(link.sourcePath, list);
		}
		for (const [path, links] of grouped) {
			const file = host.app.vault.getFileByPath(path);
			if (!file) { failed++; failures.push({ path, reason: '文件不存在' }); continue; }
			try { await host.app.vault.process(file, (content) => { const result = replaceNativeImageLinks(content, links); converted += result.converted; skipped += result.skipped; return result.content; }); } catch (error) { failed++; failures.push({ path, reason: reasonFor(error) }); }
		}
		host.processed = { success: converted, skipped, failed: failures };
		new Notice(`已转换：${converted}，跳过：${skipped}，失败：${failed}`);
		if (converted > 0) {
			host.saveCacheToSettings();
			host.renderContents();
		}
	}

export async function confirmConvertWikiLinks(host: CleanupViewContext): Promise<void> {
		const selected = host.candidates.wikiLinks.filter((item) => host.wikiSelections.has(wikiNoteLinkKey(item)));
		if (!selected.length) return;
		if (!await new ConvertWikiLinksConfirmationModal(host.app, selected.length).waitForConfirmation()) return;
		let converted = 0, skipped = 0, failed = 0;
		const failures: Array<{ path: string; reason: string }> = [];
		const currentLinks = selected.map((link) => revalidateWikiNoteLink(host.app, link));
		const grouped = new Map<string, WikiNoteLink[]>();
		for (const link of currentLinks) {
			const list = grouped.get(link.sourcePath) ?? [];
			list.push(link);
			grouped.set(link.sourcePath, list);
		}
		for (const [path, links] of grouped) {
			const file = host.app.vault.getFileByPath(path);
			if (!file) { failed++; failures.push({ path, reason: '文件不存在' }); continue; }
			try {
				await host.app.vault.process(file, (content) => {
					const result = replaceWikiNoteLinks(content, links);
					converted += result.converted;
					skipped += result.skipped;
					return result.content;
				});
			} catch (error) {
				failed++;
				failures.push({ path, reason: reasonFor(error) });
			}
		}
		host.processed = { success: converted, skipped, failed: failures };
		new Notice(`已转换：${converted}，跳过：${skipped}，失败：${failed}`);
		if (converted > 0) {
			host.wikiSelections.clear();
			host.saveCacheToSettings();
			host.renderContents();
		}
	}
