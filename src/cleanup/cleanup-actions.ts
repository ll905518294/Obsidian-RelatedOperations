import { App, FileSystemAdapter, Notice, Platform, TAbstractFile, TFile, TFolder } from 'obsidian';
import { COMMON_IMAGE_EXTENSIONS, type CleanupResult } from './cleanup-types';
import { hasHiddenPathSegment, isIgnoredPath } from '../core-utils';

const BYTES_PER_KILOBYTE = 1024;
const BYTES_PER_MEGABYTE = BYTES_PER_KILOBYTE * 1024;
const OPEN_FOLDER_FAILED_NOTICE = '打开文件夹失败。';

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

/*
 * 收集删除一批文件后“变空”的文件夹。判定口径与 findRecursivelyEmptyFolders
 * 一致：该目录及其子目录均不含文件、不含隐藏段、不在忽略目录、非根目录。
 * 只沿被删路径的父级向上检查受影响目录，避免删除后做一次全库遍历。
 */
export async function collectAutoEmptyFolders(app: App, deletedPaths: string[], ignoredFolders: string[]): Promise<TFolder[]> {
	const candidates = new Map<string, TFolder>();
	for (const path of deletedPaths) {
		let directory = parentFolder(path);
		while (directory) {
			const node = app.vault.getAbstractFileByPath(directory);
			if (node instanceof TFolder) candidates.set(directory, node);
			directory = parentFolder(directory);
		}
	}
	const empty: TFolder[] = [];
	for (const folder of candidates.values()) {
		if (isRecursivelyEmptyLike(folder, ignoredFolders)) empty.push(folder);
	}
	// 深度降序：先删子目录再删父目录，避免父目录被占用导致删除失败。
	return empty.sort((a, b) => b.path.length - a.path.length || byPath(a, b));
}

function isRecursivelyEmptyLike(folder: TFolder, ignoredFolders: string[]): boolean {
	if (!folder.path) return false;
	if (hasHiddenPathSegment(folder.path)) return false;
	if (isIgnoredPath(folder.path, ignoredFolders)) return false;
	for (const child of folder.children) {
		if (child instanceof TFolder) {
			if (!isRecursivelyEmptyLike(child, ignoredFolders)) return false;
		} else {
			return false;
		}
	}
	return true;
}

export function byPath(a: TAbstractFile, b: TAbstractFile): number {
	return a.path.localeCompare(b.path);
}

export function parentFolder(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

export function openInSystemFolder(app: App, item: TAbstractFile): void {
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
	if (item instanceof TFolder && electron.shell.openPath) void electron.shell.openPath(path).then((error) => { if (error) new Notice(OPEN_FOLDER_FAILED_NOTICE); }, () => new Notice(OPEN_FOLDER_FAILED_NOTICE));
	else {
		try { electron.shell.showItemInFolder(path); } catch { new Notice(OPEN_FOLDER_FAILED_NOTICE); }
	}
}

export function openFolderInVault(app: App, folder: TFolder): void {
	const explorer = app.workspace.getLeavesOfType('file-explorer')[0]?.view as { revealInFolder?: (file: TAbstractFile) => void } | undefined;
	if (explorer?.revealInFolder) explorer.revealInFolder(folder);
	else openInSystemFolder(app, folder);
}

export function formatBytes(bytes: number): string {
	if (bytes < BYTES_PER_KILOBYTE) return `${bytes} B`;
	if (bytes < BYTES_PER_MEGABYTE) return `${(bytes / BYTES_PER_KILOBYTE).toFixed(1)} KB`;
	return `${(bytes / BYTES_PER_MEGABYTE).toFixed(1)} MB`;
}

export function isImageFile(extension: string): boolean {
	return COMMON_IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

export function reasonFor(error: unknown): string {
	return error instanceof Error ? error.message : '未知错误';
}
