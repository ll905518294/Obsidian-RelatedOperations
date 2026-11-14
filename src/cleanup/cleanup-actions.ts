import { App, FileSystemAdapter, MarkdownView, Notice, Platform, TAbstractFile, TFile, TFolder } from 'obsidian';
import { findBrokenLinkOffset, type BrokenImageLink } from '../broken-image-links';
import { findBrokenNoteLinkOffset, type BrokenNoteLink } from '../broken-note-links';
import { nativeImageLinkOffset, type NativeImageLink } from '../native-image-links';
import type { DuplicateFileGroup } from '../duplicate-files';
import { COMMON_IMAGE_EXTENSIONS, type CleanupResult } from './cleanup-types';
export function formatScanDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export async function trashSelected(app: App, images: TFile[], folders: TFolder[]): Promise<CleanupResult> {
	const result: CleanupResult = { deleted: [], skipped: [], failed: [] };
	const moveToLocalTrash = app.fileManager.trashFile.bind(app.fileManager);
	for (const item of [...images, ...folders.sort((a, b) => b.path.length - a.path.length)]) {
		if (!app.vault.getAbstractFileByPath(item.path)) { result.skipped.push(item.path); continue; }
		try {
			await moveToLocalTrash(item);
			result.deleted.push(item.path);
		} catch (error) {
			result.failed.push({ path: item.path, reason: reasonFor(error) });
		}
	}
	return result;
}

export function byPath(a: TAbstractFile, b: TAbstractFile) {
	return a.path.localeCompare(b.path);
}

export function parentFolder(path: string) {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

export function openInSystemFolder(app: App, item: TAbstractFile) {
	if (!Platform.isDesktopApp || !(app.vault.adapter instanceof FileSystemAdapter)) {
		new Notice('仅桌面端的本地资料库支持打开所在文件夹。');
		return;
	}
	const electron = (window as Window & {
		require?: (module: string) => { shell?: { showItemInFolder(path: string): void; openPath?: (path: string) => Promise<string> } };
	}).require?.('electron');
	if (!electron?.shell) {
		new Notice('当前环境无法打开系统文件夹。');
		return;
	}
	const path = `${app.vault.adapter.getBasePath()}/${item.path}`;
	if (item instanceof TFolder && electron.shell.openPath) void electron.shell.openPath(path).then((error) => { if (error) new Notice('打开文件夹失败。'); }, () => new Notice('打开文件夹失败。'));
	else {
		try { electron.shell.showItemInFolder(path); } catch { new Notice('打开文件夹失败。'); }
	}
}

export function openFolderInVault(app: App, folder: TFolder) {
	const explorer = app.workspace.getLeavesOfType('file-explorer')[0]?.view as { revealInFolder?: (file: TAbstractFile) => void } | undefined;
	if (explorer?.revealInFolder) explorer.revealInFolder(folder);
	else openInSystemFolder(app, folder);
}

export function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImageFile(extension: string) {
	return COMMON_IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

export function reasonFor(error: unknown) {
	return error instanceof Error ? error.message : '未知错误';
}

export async function locateDuplicateReference(owner: App, file: DuplicateFileGroup['files'][number]) {
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

export async function locateBrokenNoteLink(owner: App, link: BrokenNoteLink) {
		await owner.workspace.openLinkText(link.sourcePath, '', false, { state: { mode: 'source' } });
		const view = owner.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const range = findBrokenNoteLinkOffset(view.editor.getValue(), link);
		if (!range) { new Notice('笔记内容已变化，请重新扫描。'); return; }
		const from = view.editor.offsetToPos(range.start); const to = view.editor.offsetToPos(range.end);
		view.editor.setSelection(from, to); view.editor.scrollIntoView({ from, to }, true);
	}

export async function locateNativeLink(owner: App, link: NativeImageLink) {
		await owner.workspace.openLinkText(link.sourcePath, '', false, { state: { mode: 'source' } });
		const view = owner.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const range = nativeImageLinkOffset(view.editor.getValue(), link);
		if (!range) { new Notice('笔记内容已变化，请重新扫描。'); return; }
		const from = view.editor.offsetToPos(range.start); const to = view.editor.offsetToPos(range.end);
		view.editor.setSelection(from, to); view.editor.scrollIntoView({ from, to }, true);
	}

export async function locateBrokenLink(owner: App, link: BrokenImageLink) {
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
