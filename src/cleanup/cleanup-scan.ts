import { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import { forEachWithConcurrency, hasHiddenPathSegment, isCaseSensitiveFileSystem, isFrontmatterOnly, isIgnoredPath, needsRawTextSearch, parseExtensions, parseIgnoredFolders, pathLikeTokens } from '../core-utils';
export { forEachWithConcurrency };
import { findVaultLinkScans, type VaultLinkScans } from './link-scans';
import { findDuplicateFiles, type DuplicateFileGroup } from '../duplicate-files';
import { pathKey, planImageConversions } from '../image-convert/image-convert-plan';
import { byPath } from './cleanup-actions';
import { CleanupScanAbortedError, COMMON_IMAGE_EXTENSIONS, IMAGE_CONVERSION_DEFAULT_QUALITY, IMAGE_CONVERSION_MAX_QUALITY, IMAGE_CONVERSION_MIN_QUALITY, normalizeImageConversionConfig, type CleanupCandidates, type ConvertibleImage, type ImageConversionConfig, type ImageConversionProgress, type ScanCategoryTab, type ScanProgress } from './cleanup-types';

const READ_CONCURRENCY = 8;

export interface CleanupFileSets {
	extensions: Set<string>;
	ignoredFolders: string[];
	visibleFiles: TFile[];
	images: TFile[];
	attachments: TFile[];
}

/*
 * 全量扫描与单分类刷新必须共用同一套可见性规则；否则忽略目录或
 * md/canvas 的边界调整后，两个入口会得出不同的候选集合。
 */
export function collectCleanupFileSets(app: App, imageExtensions: string, ignoredFoldersValue = ''): CleanupFileSets {
	const extensions = parseExtensions(imageExtensions);
	const ignoredFolders = parseIgnoredFolders(ignoredFoldersValue);
	const visibleFiles = app.vault.getFiles().filter((file) => !hasHiddenPathSegment(file.path) && !isIgnoredPath(file.path, ignoredFolders));
	const attachmentFiles = visibleFiles.filter((file) => !['md', 'canvas'].includes(file.extension.toLowerCase()));
	return {
		extensions,
		ignoredFolders,
		visibleFiles,
		images: attachmentFiles.filter((file) => extensions.has(file.extension.toLowerCase())),
		attachments: attachmentFiles.filter((file) => !extensions.has(file.extension.toLowerCase())),
	};
}

export async function findCleanupCandidates(app: App, imageExtensions: string, ignoredFoldersValue = '', onProgress?: (progress: ScanProgress) => void, checkLinksAndDuplicates = true, onCategoryComplete?: (tabs: ScanCategoryTab[], results: Partial<CleanupCandidates>) => void, signal?: AbortSignal): Promise<CleanupCandidates> {
	throwIfAborted(signal);
	const presence = createPresence(app);
	const { extensions, ignoredFolders, visibleFiles, images, attachments } = collectCleanupFileSets(app, imageExtensions, ignoredFoldersValue);
	// 记录快照时的路径：引用表可能仍指向旧路径，改名后的文件不能据此
	// 判定为未引用；这类文件本轮直接不报，等下次扫描重新评估。
	const snapshotPaths = new Map<TFile, string>(visibleFiles.map((file) => [file, file.path]));
	const renamedDuringScan = (file: TFile) => {
		const original = snapshotPaths.get(file);
		return original !== undefined && original !== file.path;
	};
	onProgress?.({ stage: 0, processed: visibleFiles.length, total: visibleFiles.length, currentFile: visibleFiles[visibleFiles.length - 1]?.path });
	const referenced = new Set<string>();
	for (const [sourcePath, destinations] of Object.entries(app.metadataCache.resolvedLinks)) {
		if (!sourcePath.toLowerCase().endsWith('.md')) continue;
		for (const path of Object.keys(destinations)) referenced.add(path);
	}
	const canvases = app.vault.getFiles().filter((file) => file.extension.toLowerCase() === 'canvas');
	let canvasParseFailed = false;
	for (const [index, canvas] of canvases.entries()) {
		throwIfAborted(signal);
		const paths = await referencedByCanvas(app, canvas);
		if (paths === null) {
			// Canvas 解析失败时无法确定它引用了哪些图片；保守地把全部
			// 图片与附件视为可能被引用，避免产生错误的未引用候选。
			canvasParseFailed = true;
		} else {
			for (const path of paths) referenced.add(path);
		}
		onProgress?.({ stage: 1, processed: index + 1, total: canvases.length || 1, currentFile: canvas.path });
	}
	if (canvasParseFailed) {
		for (const file of images) referenced.add(file.path);
		for (const file of attachments) referenced.add(file.path);
	}
	onProgress?.({ stage: 2, processed: 0, total: app.vault.getMarkdownFiles().length });
	throwIfAborted(signal);
	// Conservative textual pass: HTML image tags, frontmatter path values, and
	// code-block text do not appear in resolvedLinks. Any textual mention of the
	// file name or path counts as a reference so that such images are never
	// flagged as orphans.
	await markFilesReferencedByText(app, [...images, ...attachments], referenced, (processed, total, currentFile) => onProgress?.({ stage: 2, processed, total, currentFile }), signal);
	throwIfAborted(signal);
	// 扫描期间用户可能删除或改名文件；发布前按当前库状态剔除，避免面板
	// 展示已经不存在的路径，或在稍后清理时对旧路径报错。
	const orphanImages = pruneStillPresent(presence, images.filter((file) => !renamedDuringScan(file) && !referenced.has(file.path))).sort(byPath);
	const orphanAttachments = pruneStillPresent(presence, attachments.filter((file) => !renamedDuringScan(file) && !referenced.has(file.path))).sort(byPath);
	onCategoryComplete?.(['images', 'attachments'], {
		images: orphanImages,
		attachments: orphanAttachments,
	});
	throwIfAborted(signal);
	const emptyFiles = pruneStillPresent(presence, (await findEmptyFiles(visibleFiles, extensions, app, (processed, total, currentFile) => onProgress?.({ stage: 3, processed, total, currentFile }), signal)).filter((file) => !renamedDuringScan(file) && !referenced.has(file.path)));
	const folders = pruneStillPresent(presence, findRecursivelyEmptyFolders(app.vault.getRoot(), ignoredFolders)).sort((a, b) => b.path.length - a.path.length || byPath(a, b));
	onProgress?.({ stage: 3, processed: visibleFiles.length, total: visibleFiles.length, currentFile: visibleFiles[visibleFiles.length - 1]?.path });
	onCategoryComplete?.(['empty-files', 'folders'], { emptyFiles, folders });
	throwIfAborted(signal);
	onProgress?.({ stage: 4, processed: 0, total: 1 });
	const scannedLinks: VaultLinkScans = checkLinksAndDuplicates
		? findVaultLinkScans(app, imageExtensions)
		: { brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], wikiLinks: [] };
	const linkScans = pruneLinkScans(app, presence, scannedLinks);
	const { brokenLinks, nativeLinks, brokenNoteLinks, wikiLinks } = linkScans;
	onCategoryComplete?.(['broken-links', 'native-links', 'broken-note-links'], { brokenLinks, nativeLinks, brokenNoteLinks });
	onCategoryComplete?.(['wiki-links'], { wikiLinks });
	throwIfAborted(signal);
	onProgress?.({ stage: 5, processed: 0, total: 1 });
	throwIfAborted(signal);
	const duplicateResult = checkLinksAndDuplicates ? await findDuplicateFiles(app, ignoredFoldersValue, (progress) => onProgress?.({ stage: 5, ...progress }), signal) : { groups: [], warnings: [] };
	const duplicates = pruneDuplicateGroups(app, presence, duplicateResult.groups);
	const duplicateWarnings = duplicateResult.warnings.filter((warning) => stillExists(presence, warning.path));
	onCategoryComplete?.(['duplicates'], { duplicates, duplicateWarnings });
	throwIfAborted(signal);
	// 分类是边扫边发布的；返回前再校验一次，覆盖发布之后到收尾之间发生
	// 的删除/新建，保证面板最终落盘的结果与当前库一致。
	const finalImages = pruneStillPresent(presence, orphanImages);
	const finalAttachments = pruneStillPresent(presence, orphanAttachments);
	const finalEmptyFiles = pruneStillPresent(presence, emptyFiles);
	const finalLinks = pruneLinkScans(app, presence, linkScans);
	const finalDuplicates = pruneDuplicateGroups(app, presence, duplicates);
	const finalWarnings = duplicateWarnings.filter((warning) => stillExists(presence, warning.path));
	// 空文件夹是纯内存推导，收尾时重算一次，覆盖扫描期间新建/删除文件
	// 导致目录从“空”变成“非空”的窗口。
	const finalFolders = pruneStillPresent(presence, findRecursivelyEmptyFolders(app.vault.getRoot(), ignoredFolders)).sort((a, b) => b.path.length - a.path.length || byPath(a, b));
	return {
		images: finalImages,
		attachments: finalAttachments,
		emptyFiles: finalEmptyFiles,
		folders: finalFolders,
		brokenLinks: finalLinks.brokenLinks,
		nativeLinks: finalLinks.nativeLinks,
		brokenNoteLinks: finalLinks.brokenNoteLinks,
		wikiLinks: finalLinks.wikiLinks,
		duplicates: finalDuplicates,
		duplicateWarnings: finalWarnings,
		convertibleImages: [],
	};
}

export async function findEmptyFiles(files: TFile[], imageExtensions: Set<string>, app: App, onProgress?: (processed: number, total: number, currentFile: string) => void, signal?: AbortSignal): Promise<TFile[]> {
	const result: TFile[] = [];
	let processed = 0;
	await forEachWithConcurrency(files, READ_CONCURRENCY, async (file) => {
		throwIfAborted(signal);
		processed += 1;
		onProgress?.(processed, files.length, file.path);
		const extension = file.extension.toLowerCase();
		if (extension === 'canvas') return;
		if (file.stat.size === 0 && !imageExtensions.has(extension) && !COMMON_IMAGE_EXTENSIONS.has(extension)) { result.push(file); return; }
		if (extension !== 'md') return;
		let content: string;
		try {
			content = await app.vault.cachedRead(file);
		} catch {
			// 文件在扫描期间被删除或暂时不可读；不能据此判断它是空文件。
			return;
		}
		if (isFrontmatterOnly(content)) result.push(file);
	});
	return result.sort(byPath);
}

export async function markFilesReferencedByText(app: App, images: TFile[], referenced: Set<string>, onProgress?: (processed: number, total: number, currentFile: string) => void, signal?: AbortSignal): Promise<void> {
	const remaining = images.filter((image) => !referenced.has(image.path));
	if (remaining.length === 0) return;
	const unresolved = new Set(remaining.map((image) => image.path));
	const markReferenced = (path: string) => {
		referenced.add(path);
		unresolved.delete(path);
	};
	const byBasename = new Map<string, string[]>();
	const exoticNames: string[] = [];
	for (const image of remaining) {
		const key = image.name.toLowerCase();
		const paths = byBasename.get(key) ?? [];
		paths.push(image.path);
		byBasename.set(key, paths);
		if (needsRawTextSearch(image.name)) exoticNames.push(key);
	}
	// A token always ends with an extension, so only the part after the last
	// slash and its space-separated suffixes can match a file name. Matching the
	// tail keeps long prose lines from enumerating every word-prefix candidate.
	const markToken = (token: string) => {
		const cleaned = token.replace(/^[./\\]+/, '');
		const slash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
		let piece = slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
		while (piece) {
			for (const path of byBasename.get(piece) ?? []) markReferenced(path);
			if (piece.includes('%')) {
				for (const path of byBasename.get(lastPathSegment(safeDecodePath(piece)).toLowerCase()) ?? []) markReferenced(path);
			}
			const space = piece.indexOf(' ');
			if (space < 0) return;
			piece = piece.slice(space + 1);
		}
	};
	const markdownFiles = app.vault.getMarkdownFiles();
	const BATCH = READ_CONCURRENCY * 4;
	for (let start = 0; start < markdownFiles.length; start += BATCH) {
		throwIfAborted(signal);
		const batch = markdownFiles.slice(start, start + BATCH);
		// 单篇笔记读取失败（扫描期间被删除、被外部程序占用）不应中断整次扫描。
		const contents = await Promise.all(batch.map(async (file) => {
			try {
				return await app.vault.cachedRead(file);
			} catch {
				return null;
			}
		}));
		throwIfAborted(signal);
		for (const [offset, content] of contents.entries()) {
			const file = batch[offset]!;
			onProgress?.(start + offset + 1, markdownFiles.length, file.path);
			if (content === null) {
				// 读不到内容的笔记可能引用任意图片；保守地把尚未确认的条目
				// 全部视为被引用，宁可漏报也不产生可删除的误报。
				for (const path of [...unresolved]) markReferenced(path);
				return;
			}
			for (const token of pathLikeTokens(content)) markToken(token);
			if (exoticNames.length) {
				// Lowercase once per note instead of once per exotic file name.
				const lowered = content.toLowerCase();
				for (let index = exoticNames.length - 1; index >= 0; index--) {
					const key = exoticNames[index]!;
					if (!lowered.includes(key)) continue;
					for (const path of byBasename.get(key) ?? []) markReferenced(path);
					exoticNames.splice(index, 1);
				}
			}
			if (unresolved.size === 0) return;
		}
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new CleanupScanAbortedError();
}

/*
 * 扫描是多阶段、可中止的；用户可能在任意阶段删除、改名或新建文件。
 * 结果发布前统一按当前库状态校验。宿主没有提供查询 API 时（测试桩）
 * 不做剔除；索引与 getFiles 短暂不一致时，只要文件仍在列表里就保留。
 */
function createPresence(app: App) {
	const supported = typeof app.vault.getAbstractFileByPath === 'function';
	const at = (path: string): TAbstractFile | null | undefined => (supported ? app.vault.getAbstractFileByPath(path) : undefined);
	// 索引偶发缺失时退回 getFiles 判定。候选与链接可能上千条，逐条全量
	// 遍历会退化成平方级；按当前列表惰性建一次集合，整轮扫描复用。
	let listedFiles: Set<TAbstractFile> | undefined;
	let listedPaths: Set<string> | undefined;
	return {
		file(item: TAbstractFile): boolean {
			const current = at(item.path);
			if (current === undefined || current === item) return true;
			if (current) return false;
			listedFiles ??= new Set(app.vault.getFiles());
			return listedFiles.has(item);
		},
		path(path: string): boolean {
			const current = at(path);
			if (current === undefined) return true;
			if (current) return true;
			listedPaths ??= new Set(app.vault.getFiles().map((file) => file.path));
			return listedPaths.has(path);
		},
		at,
	};
}

type Presence = ReturnType<typeof createPresence>;

function pruneStillPresent<T extends TAbstractFile>(presence: Presence, items: T[]): T[] {
	return items.filter((item) => presence.file(item));
}

function stillExists(presence: Presence, path: string): boolean {
	return presence.path(path);
}

function pruneLinkScans(app: App, presence: Presence, scans: VaultLinkScans): VaultLinkScans {
	const brokenNow = (link: { sourcePath: string; linkPath: string }) => stillExists(presence, link.sourcePath)
		&& !app.metadataCache.getFirstLinkpathDest(link.linkPath, link.sourcePath);
	return {
		brokenLinks: scans.brokenLinks.filter(brokenNow),
		brokenNoteLinks: scans.brokenNoteLinks.filter(brokenNow),
		// 未解析的原生嵌入本来就带 reason 展示；只剔除“扫描时还能解析、
		// 收尾时目标已被删除”的条目。
		nativeLinks: scans.nativeLinks.filter((link) => stillExists(presence, link.sourcePath)
			&& (!link.file || !!app.metadataCache.getFirstLinkpathDest(link.linkPath, link.sourcePath))),
		wikiLinks: scans.wikiLinks.filter((link) => stillExists(presence, link.sourcePath)
			&& !!app.metadataCache.getFirstLinkpathDest(link.linkPath, link.sourcePath)),
	};
}

function pruneDuplicateGroups(app: App, presence: Presence, groups: DuplicateFileGroup[]): DuplicateFileGroup[] {
	const stillMatches = (file: DuplicateFileGroup['files'][number]) => {
		const current = presence.at(file.path);
		if (current === undefined) return true;
		if (!current) return presence.path(file.path);
		if ('children' in current) return false;
		const stat = (current as { stat?: { size: number; mtime: number } }).stat;
		return !!stat && stat.size === file.size && stat.mtime === file.mtime;
	};
	return groups
		.map((group) => ({ ...group, files: group.files.filter(stillMatches) }))
		.filter((group) => group.files.length > 1);
}

/*
 * 图片转换的候选只做格式与可见性筛选，不解码、不估算体积；体积估算由
 * estimateConversions 在用户手动触发时完成。imageExtensions 是用户在设置里
 * 声明的“图片”边界，不在其中的扩展名同样不进入转换候选。
 */
export function collectConvertibleImages(app: App, config: ImageConversionConfig, imageExtensions: string, ignoredFoldersValue = ''): TFile[] {
	const normalized = normalizeImageConversionConfig(config);
	const sources = new Set(normalized.sources);
	const target = normalized.target;
	const extensions = parseExtensions(imageExtensions);
	const ignoredFolders = parseIgnoredFolders(ignoredFoldersValue);
	return app.vault.getFiles()
		.filter((file) => {
			const extension = file.extension.toLowerCase();
			const format = extension === 'jpeg' ? 'jpg' : extension;
			// 目标格式本身不是候选：PNG→JPG 后新出现的 jpg 不应再次进入列表。
			if (format === target) return false;
			return sources.has(format) && extensions.has(extension)
				&& !hasHiddenPathSegment(file.path) && !isIgnoredPath(file.path, ignoredFolders);
		})
		.sort(byPath);
}

/*
 * 快速预估：不读取、不解码、不重编码，只按源格式→目标格式的经验压缩比与
 * 文件体积（stat.size）推算目标体积，把 5000+ 张的估算压到秒级。
 * 引用处数直接取自 metadataCache.resolvedLinks 内存索引，不读笔记正文；
 * 真正的可改写性、透明图跳过、40MP 上限等在转换时由 runner 精确校验。
 * 目标冲突与同格式仍按 planImageConversions 判定。中止在文件之间生效，
 * 返回已完成条目，不抛错。
 */
const ESTIMATE_RATIO_BY_FORMAT: Record<string, number> = {
	'png->jpg': 0.10,
	'png->webp': 0.08,
	'jpg->webp': 0.72,
	'jpg->png': 3.0,
	'webp->jpg': 1.6,
	'webp->png': 3.0,
	'bmp->jpg': 0.06,
	'bmp->webp': 0.05,
	'bmp->png': 0.8,
	'avif->jpg': 0.9,
	'avif->webp': 0.9,
	'avif->png': 3.0,
};
const DEFAULT_ESTIMATE_RATIO = 0.5;

/*
 * 经验压缩比只是量级参考：目标为有损格式（JPG/WebP）时按质量线性缩放，
 * 目标为 PNG（无损）时不缩放。100 不是无损，只是最高质量；JPG/WebP 在
 * quality=100 时仍有损，只有 PNG 目标无损。最低保留 1 字节，保证界面按
 * 「已估算」展示。
 */
function estimateTargetBytes(oldBytes: number, source: string, target: string, quality: number): number {
	const ratio = ESTIMATE_RATIO_BY_FORMAT[`${source}->${target}`] ?? DEFAULT_ESTIMATE_RATIO;
	const clampedQuality = Math.min(IMAGE_CONVERSION_MAX_QUALITY, Math.max(IMAGE_CONVERSION_MIN_QUALITY, quality));
	const qualityScale = target === 'png' ? 1 : clampedQuality / IMAGE_CONVERSION_DEFAULT_QUALITY;
	return Math.max(1, Math.round(oldBytes * ratio * qualityScale));
}

// 一次遍历引用索引，统计每张图片被引用到多少处；不读任何笔记正文。
function countIndexedReferences(app: App, caseSensitive: boolean): Map<string, number> {
	const counts = new Map<string, number>();
	for (const destinations of Object.values(app.metadataCache.resolvedLinks ?? {})) {
		if (!destinations) continue;
		for (const [targetPath, count] of Object.entries(destinations)) {
			if (typeof count !== 'number' || count <= 0) continue;
			const key = pathKey(targetPath, caseSensitive);
			counts.set(key, (counts.get(key) ?? 0) + count);
		}
	}
	return counts;
}

export async function estimateConversions(
	app: App,
	files: TFile[],
	config: ImageConversionConfig,
	onProgress?: (progress: ImageConversionProgress) => void,
	signal?: AbortSignal,
): Promise<ConvertibleImage[]> {
	const normalized = normalizeImageConversionConfig(config);
	const caseSensitive = isCaseSensitiveFileSystem();
	const total = files.length;
	// plan 统一处理目标冲突、大小写归一化与同格式；结果直接作为预标记。
	const plan = planImageConversions(
		files.map((file) => ({ path: file.path, size: file.stat?.size ?? 0 })),
		normalized.target,
		{
			existingPaths: app.vault.getFiles().map((file) => file.path),
			caseSensitive,
		},
	);
	const planned = new Set(plan.items.map((item) => item.path));
	const planSkipped = new Map(plan.skipped.map((item) => [item.path, item.reason]));
	const referenceCounts = countIndexedReferences(app, caseSensitive);
	const items: ConvertibleImage[] = [];
	let processed = 0;
	onProgress?.({ processed, total });
	for (const file of files) {
		if (signal?.aborted) break;
		const extension = file.extension.toLowerCase();
		const source = extension === 'jpeg' ? 'jpg' : extension;
		const base: ConvertibleImage = {
			path: file.path,
			extension,
			width: 0,
			height: 0,
			oldBytes: file.stat?.size ?? 0,
			newBytes: 0,
			hasAlpha: false,
			referenceCount: referenceCounts.get(pathKey(file.path, caseSensitive)) ?? 0,
		};
		const planBlockedReason = planSkipped.get(file.path);
		if (source === normalized.target) {
			// 同格式是“永远不能转”的噪声：不出现在估算结果里。
		} else if (planBlockedReason) {
			items.push({ ...base, blockedReason: planBlockedReason });
		} else if (!planned.has(file.path)) {
			items.push({ ...base, blockedReason: 'unsupported-source' });
		} else {
			items.push({ ...base, newBytes: estimateTargetBytes(base.oldBytes, source, normalized.target, normalized.quality) });
		}
		processed += 1;
		onProgress?.({ processed, total, currentPath: file.path });
	}
	return items.sort((a, b) => a.path.localeCompare(b.path));
}

export async function referencedByCanvas(app: App, canvas: TFile): Promise<string[] | null> {
	try {
		const content = JSON.parse(await app.vault.read(canvas)) as { nodes?: Array<{ file?: unknown }> };
		return (content.nodes ?? []).flatMap((node) => {
			if (typeof node.file !== 'string') return [];
			const file = app.metadataCache.getFirstLinkpathDest(node.file, canvas.path);
			return file instanceof TFile ? [file.path] : [];
		});
	} catch {
		return null;
	}
}

export function findRecursivelyEmptyFolders(folder: TFolder, ignoredFolders: string[] = []): TFolder[] {
	const candidates: TFolder[] = [];
	const visit = (current: TFolder): boolean => {
		// Hidden folders such as .obsidian, .trash, and .git are system folders:
		// never candidates, and they block their parent from being listed as empty.
		if (hasHiddenPathSegment(current.path)) return false;
		if (isIgnoredPath(current.path, ignoredFolders)) return false;
		let onlyEmptyFolders = true;
		for (const child of current.children) {
			if (child instanceof TFolder) {
				if (!visit(child)) onlyEmptyFolders = false;
			} else {
				onlyEmptyFolders = false;
			}
		}
		if (onlyEmptyFolders && current.path) candidates.push(current);
		return onlyEmptyFolders;
	};
	visit(folder);
	return candidates;
}

function lastPathSegment(path: string) {
	const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return index >= 0 ? path.slice(index + 1) : path;
}

function safeDecodePath(path: string) {
	try { return decodeURIComponent(path); } catch { return path; }
}
