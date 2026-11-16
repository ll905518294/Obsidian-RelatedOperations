import { App, FileSystemAdapter, Notice, Platform, TAbstractFile, TFile, TFolder } from 'obsidian';
import { COMMON_IMAGE_EXTENSIONS, type CleanupResult } from './cleanup-types';

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
	if (item instanceof TFolder && electron.shell.openPath) void electron.shell.openPath(path).then((error) => { if (error) new Notice('打开文件夹失败。'); }, () => new Notice('打开文件夹失败。'));
	else {
		try { electron.shell.showItemInFolder(path); } catch { new Notice('打开文件夹失败。'); }
	}
}

export function openFolderInVault(app: App, folder: TFolder): void {
	const explorer = app.workspace.getLeavesOfType('file-explorer')[0]?.view as { revealInFolder?: (file: TAbstractFile) => void } | undefined;
	if (explorer?.revealInFolder) explorer.revealInFolder(folder);
	else openInSystemFolder(app, folder);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImageFile(extension: string): boolean {
	return COMMON_IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

export function reasonFor(error: unknown): string {
	return error instanceof Error ? error.message : '未知错误';
}
