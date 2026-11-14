import { TFile, TFolder } from 'obsidian';
import type { BrokenImageLink } from '../broken-image-links';
import type { BrokenNoteLink } from '../broken-note-links';
import type { NativeImageLink } from '../native-image-links';
import type { DuplicateFileGroup } from '../duplicate-files';
import type { OrphanCleanupCache } from '../settings';

export type ImageGrouping = 'none' | 'path' | 'extension';
export const CLEANUP_PAGE_SIZE = 100;
export const COMMON_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico', 'tif', 'tiff', 'heic', 'heif']);

export interface CleanupCandidates {
	images: TFile[];
	attachments: TFile[];
	emptyFiles: TFile[];
	folders: TFolder[];
	brokenLinks: BrokenImageLink[];
	nativeLinks: NativeImageLink[];
	brokenNoteLinks: BrokenNoteLink[];
	duplicates: DuplicateFileGroup[];
	duplicateWarnings: Array<{ path: string; reason: string }>;
}

export type { BrokenImageLink, BrokenNoteLink, NativeImageLink };

export interface CleanupResult {
	deleted: string[];
	skipped: string[];
	failed: Array<{ path: string; reason: string }>;
}

export interface OrphanImageExtensions {
	orphanImageExtensions: string;
	orphanIgnoredFolders: string;
}

export type ScanStage = { label: string; state: 'pending' | 'scanning' | 'done'; elapsedMs: number; startedAt?: number };
export type ScanProgress = { stage: number; processed: number; total: number; currentFile?: string };
export type CleanupTab = 'overview' | 'images' | 'attachments' | 'broken-links' | 'native-links' | 'broken-note-links' | 'empty-files' | 'folders' | 'duplicates';
export type ScanCategoryTab = Exclude<CleanupTab, 'overview'>;

export const CLEANUP_CATEGORIES: Array<{ tab: ScanCategoryTab; label: string; description: string; icon: string }> = [
	{ tab: 'images', label: '未引用图片', description: '未被任何笔记引用的图片资源', icon: 'image' },
	{ tab: 'attachments', label: '未引用附件', description: '未被引用的非图片附件', icon: 'paperclip' },
	{ tab: 'broken-links', label: '失效图片链接', description: '指向不存在目标文件的图片链接', icon: 'unlink' },
	{ tab: 'native-links', label: '原生图片链接', description: '尚未转为 Wiki 链接的图片引用', icon: 'file-image' },
	{ tab: 'broken-note-links', label: '失效笔记链接', description: '指向不存在笔记的内部链接', icon: 'help-circle' },
	{ tab: 'empty-files', label: '空文件', description: '内容为空且未被引用的文件', icon: 'file-minus' },
	{ tab: 'folders', label: '空文件夹', description: '仅包含空子目录的文件夹', icon: 'folder-minus' },
	{ tab: 'duplicates', label: '重复文件', description: '内容哈希相同的文件组', icon: 'copy' },
];

export interface OrphanCleanupHost {
	close(): void;
}

export interface OrphanCleanupOptions {
	cachedCandidates?: CleanupCandidates;
	cachedSettings?: {
		orphanImageExtensions: string;
		orphanIgnoredFolders: string;
	};
	saveCache?: (cache: OrphanCleanupCache) => Promise<void>;
}
