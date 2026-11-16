import type { App, TFile, TFolder } from 'obsidian';
import type { BrokenImageLink } from '../broken-image-links';
import type { BrokenNoteLink } from '../broken-note-links';
import type { NativeImageLink } from '../native-image-links';
import type { WikiNoteLink } from '../wiki-note-links';
import type { DuplicateFileGroup } from '../duplicate-files';
import type { OrphanCleanupCache } from './cleanup-cache';
import { normalizeExtensionToken } from '../core-utils.ts';

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
	wikiLinks: WikiNoteLink[];
	duplicates: DuplicateFileGroup[];
	duplicateWarnings: Array<{ path: string; reason: string }>;
	convertibleImages: TFile[];
}

export type { BrokenImageLink, BrokenNoteLink, NativeImageLink, WikiNoteLink };

export interface CleanupResult {
	deleted: string[];
	skipped: string[];
	failed: Array<{ path: string; reason: string }>;
}

export interface OrphanImageExtensions {
	orphanImageExtensions: string;
	orphanIgnoredFolders: string;
	imageConversion?: ImageConversionConfig;
}

export type ScanStage = { label: string; state: 'pending' | 'scanning' | 'done'; elapsedMs: number; startedAt?: number };
export type ScanProgress = { stage: number; processed: number; total: number; currentFile?: string };
export type CleanupTab = 'overview' | 'images' | 'attachments' | 'broken-links' | 'native-links' | 'broken-note-links' | 'wiki-links' | 'empty-files' | 'folders' | 'duplicates' | 'image-convert';
export type ScanCategoryTab = Exclude<CleanupTab, 'overview'>;

export const CONVERTIBLE_SOURCE_EXTENSIONS = ['png', 'jpg', 'webp', 'bmp', 'avif'] as const;
export type ImageConversionTarget = 'jpg' | 'webp' | 'png';
export type ImageConversionAlpha = 'flatten' | 'skip';

export interface ImageConversionConfig {
	sources: string[];
	target: ImageConversionTarget;
	quality: number;
	alpha: ImageConversionAlpha;
}

export const DEFAULT_IMAGE_CONVERSION: ImageConversionConfig = {
	sources: ['png'],
	target: 'jpg',
	quality: 85,
	alpha: 'flatten',
};

export interface ConvertibleImage {
	path: string;
	extension: string;
	width: number;
	height: number;
	oldBytes: number;
	newBytes: number;
	hasAlpha: boolean;
	referenceCount: number;
	blockedReason?: string;
}

export type ImageConversionProgress = { processed: number; total: number; currentPath?: string };

export interface ImageConversionSkippedItem {
	path: string;
	// 01 的英文原因标识；reasonText 是给界面展示的中文说明。
	reason: string;
	reasonText?: string;
}

export interface ImageConversionFailedItem {
	path: string;
	reason: string;
	reasonText?: string;
}

export interface ImageConversionConvertedItem {
	path: string;
	newPath: string;
	oldBytes: number;
	newBytes: number;
}

export interface ImageConversionResult {
	converted: number;
	skipped: number;
	failed: number;
	savedBytes: number;
	aborted?: boolean;
	pendingTrash?: Array<{ path: string; newPath: string }>;
	convertedItems: ImageConversionConvertedItem[];
	skippedItems: ImageConversionSkippedItem[];
	failedItems: ImageConversionFailedItem[];
}

export interface ImageConversionState extends ImageConversionConfig {
	// 渲染层读取嵌套 config；与顶层 sources/target/quality/alpha 保持同步。
	config: ImageConversionConfig;
	items: ConvertibleImage[];
	estimating: boolean;
	converting: boolean;
	estimateProgress: ImageConversionProgress;
	lastResult?: ImageConversionResult;
	abort?: () => void;
}

/*
 * data.json 里的旧配置可能缺字段或带非法值；这里只做字段级收敛，
 * 不信任持久化内容，缺省值始终来自 DEFAULT_IMAGE_CONVERSION。
 */
export function normalizeImageConversionConfig(raw: unknown, defaults: ImageConversionConfig = DEFAULT_IMAGE_CONVERSION): ImageConversionConfig {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...defaults, sources: [...defaults.sources] };
	const value = raw as Record<string, unknown>;
	const sources = Array.isArray(value.sources)
		? value.sources
			.filter((item): item is string => typeof item === 'string')
			.map(normalizeExtensionToken)
			.map((item) => (item === 'jpeg' ? 'jpg' : item))
			.filter((item, index, list) => (CONVERTIBLE_SOURCE_EXTENSIONS as readonly string[]).includes(item) && list.indexOf(item) === index)
		: [...defaults.sources];
	const target = value.target === 'webp' || value.target === 'png' || value.target === 'jpg' ? value.target : defaults.target;
	const qualityValue = typeof value.quality === 'number' && Number.isFinite(value.quality) ? Math.round(value.quality) : defaults.quality;
	const quality = Math.min(95, Math.max(50, qualityValue));
	const alpha = value.alpha === 'skip' || value.alpha === 'flatten' ? value.alpha : defaults.alpha;
	return { sources, target, quality, alpha };
}

export interface CleanupScanError {
	reason: string;
	failedTabs: CleanupTab[];
}

export class CleanupScanAbortedError extends Error {
	constructor() {
		super('扫描已中止');
		this.name = 'CleanupScanAbortedError';
	}
}

/*
 * 面板与扫描模块可能被打包成不同模块实例；除 instanceof 外再按 name
 * 兜底识别，避免中止被误判成普通扫描失败。
 */
export function isCleanupScanAborted(error: unknown): boolean {
	return error instanceof CleanupScanAbortedError
		|| (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'CleanupScanAbortedError');
}

export const CLEANUP_CATEGORIES: Array<{ tab: ScanCategoryTab; label: string; description: string; icon: string }> = [
	{ tab: 'images', label: '未引用图片', description: '未被任何笔记引用的图片资源', icon: 'image' },
	{ tab: 'attachments', label: '未引用附件', description: '未被引用的非图片附件', icon: 'paperclip' },
	{ tab: 'broken-links', label: '失效图片链接', description: '指向不存在目标文件的图片链接', icon: 'unlink' },
	{ tab: 'native-links', label: '原生图片链接', description: '尚未转为标准 Markdown 图片链接的 Wiki 图片嵌入', icon: 'file-image' },
	{ tab: 'broken-note-links', label: '失效笔记链接', description: '指向不存在笔记的内部链接', icon: 'help-circle' },
	{ tab: 'wiki-links', label: 'Wiki 笔记链接', description: '尚未转为标准 Markdown 链接的 Wiki 引用', icon: 'link' },
	{ tab: 'empty-files', label: '空文件', description: '内容为空且未被引用的文件', icon: 'file-minus' },
	{ tab: 'folders', label: '空文件夹', description: '仅包含空子目录的文件夹', icon: 'folder-minus' },
	{ tab: 'duplicates', label: '重复文件', description: '内容哈希相同的文件组', icon: 'copy' },
];

export interface OrphanCleanupHost {
	close(): void;
}

export interface CleanupViewContext {
	contentEl: HTMLElement;
	app: App;
	settings: OrphanImageExtensions;
	activeTab: CleanupTab;
	candidates: CleanupCandidates;
	selections: Set<string>;
	convertSelections: Set<string>;
	linkSelections: Set<string>;
	nativeSelections: Set<string>;
	noteLinkSelections: Set<string>;
	wikiSelections: Set<string>;
	duplicateSelections: Set<string>;
	scanning: boolean;
	hasScanned: boolean;
	showHelp: boolean;
	scanStages: ScanStage[];
	scanProgress: ScanProgress;
	scanElapsedMs: number;
	scannedTabs: Set<CleanupTab>;
	scanningTabs: Set<CleanupTab>;
	dirtyTabs: Set<CleanupTab>;
	conversion: ImageConversionState;
	imageGrouping: ImageGrouping;
	attachmentGrouping: ImageGrouping;
	pages: Map<string, number>;
	processed?: { success: number; skipped: number; failed: Array<{ path: string; reason: string }> };
	lastScanError?: CleanupScanError;
	lastScanAborted?: boolean;
	lastScannedAt?: string;
	showingCachedResult?: boolean;
	scan(): Promise<void>;
	abortScan(): void;
	scanCategory(tab: ScanCategoryTab): Promise<void>;
	scanTab(tab: CleanupTab): Promise<void>;
	activateTab(tab: CleanupTab): Promise<void>;
	refreshCurrentTab(): Promise<void>;
	renderContents(): void;
	saveCacheToSettings(): void;
	updateSelectionSummary(summary?: HTMLElement): void;
	trashSingleImage(file: TFile): Promise<void>;
	trashPreviewImage(file: TFile): Promise<void>;
	cleanDuplicateLinks(file: DuplicateFileGroup['files'][number]): Promise<void>;
	deleteDuplicateFile(file: DuplicateFileGroup['files'][number]): Promise<void>;
	estimateConversions(): Promise<void>;
	convertSelected(): Promise<void>;
	setConversionConfig(patch: Partial<ImageConversionConfig>): Promise<void>;
	abortEstimate?(): void;
	abortConvert?(): void;
}

export interface OrphanCleanupOptions {
	// 新缓存是纯数据，旧缓存可能直接带 TFile 或已损坏；恢复时统一交给
	// restoreCleanupCandidates 校验。
	cachedCandidates?: unknown;
	cachedAt?: string;
	cachedSettings?: {
		orphanImageExtensions: string;
		orphanIgnoredFolders: string;
	};
	saveCache?: (cache: OrphanCleanupCache) => Promise<void> | void;
	saveSettings?: () => Promise<void>;
}
