import { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import { forEachWithConcurrency, hasHiddenPathSegment, isCaseSensitiveFileSystem, isFrontmatterOnly, isIgnoredPath, needsRawTextSearch, parseExtensions, parseIgnoredFolders, pathLikeTokens } from '../core-utils';
export { forEachWithConcurrency };
import { findVaultLinkScans, type VaultLinkScans } from './link-scans';
import { findDuplicateFiles, type DuplicateFileGroup } from '../duplicate-files';
import { isWithinPixelLimit, type ImageCodec } from '../image-convert/image-codec';
import { findImageReferences, findImageReferencesBatch, type ImageReferenceScanResult } from '../image-convert/image-convert-links';
import { planImageConversions, type ImageConvertPlanItem } from '../image-convert/image-convert-plan';
import { byPath } from './cleanup-actions';
import { CleanupScanAbortedError, COMMON_IMAGE_EXTENSIONS, normalizeImageConversionConfig, type CleanupCandidates, type ConvertibleImage, type ImageConversionConfig, type ImageConversionProgress, type ScanCategoryTab, type ScanProgress } from './cleanup-types';

const READ_CONCURRENCY = 8;
// 解码一张 40MP 图约占 160MB（宽×高×4），2 路并发峰值约 320MB；
// 3 路会再加 160MB，吞吐收益抵不上低配机器的内存风险，故保持 2。
// 编码结束后由 codec.release 立刻释放画布，避免旧画布堆积到 GC。
const CONVERSION_CONCURRENCY = 2;

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
	onProgress?.({ stage: 0, processed: visibleFiles.length, total: visibleFiles.length, currentFile: visibleFiles.at(-1)?.path });
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
	const orphanImages = pruneStillPresent(presence, images.filter((file) => !referenced.has(file.path))).sort(byPath);
	const orphanAttachments = pruneStillPresent(presence, attachments.filter((file) => !referenced.has(file.path))).sort(byPath);
	onCategoryComplete?.(['images', 'attachments'], {
		images: orphanImages,
		attachments: orphanAttachments,
	});
	throwIfAborted(signal);
	const emptyFiles = pruneStillPresent(presence, (await findEmptyFiles(visibleFiles, extensions, app, (processed, total, currentFile) => onProgress?.({ stage: 3, processed, total, currentFile }), signal)).filter((file) => !referenced.has(file.path)));
	const folders = pruneStillPresent(presence, findRecursivelyEmptyFolders(app.vault.getRoot(), ignoredFolders)).sort((a, b) => b.path.length - a.path.length || byPath(a, b));
	onProgress?.({ stage: 3, processed: visibleFiles.length, total: visibleFiles.length, currentFile: visibleFiles.at(-1)?.path });
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
	return {
		file(item: TAbstractFile): boolean {
			const current = at(item.path);
			if (current === undefined || current === item) return true;
			if (current) return false;
			return app.vault.getFiles().some((file) => file === item);
		},
		path(path: string): boolean {
			const current = at(path);
			if (current === undefined) return true;
			if (current) return true;
			return app.vault.getFiles().some((file) => file.path === path);
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
 * 每张图读一次二进制、解码一次、编码一次，用 2 个并发限制内存峰值。
 * 解码失败、超过 40MP、目标文件已存在的条目保留在结果里并带 blockedReason，
 * 让界面能说明“为什么不能转”。中止时返回已经完成的条目，不抛错。
 */
export async function estimateConversions(
	app: App,
	files: TFile[],
	config: ImageConversionConfig,
	codec: ImageCodec,
	onProgress?: (progress: ImageConversionProgress) => void,
	signal?: AbortSignal,
): Promise<ConvertibleImage[]> {
	const normalized = normalizeImageConversionConfig(config);
	const total = files.length;
	// plan 统一处理目标冲突、大小写归一化与同格式；结果直接作为预标记。
	const plan = planImageConversions(
		files.map((file) => ({ path: file.path, size: file.stat?.size ?? 0 })),
		normalized.target,
		{
			existingPaths: app.vault.getFiles().map((file) => file.path),
			caseSensitive: isCaseSensitiveFileSystem(),
		},
	);
	const planned = new Map(plan.items.map((item) => [item.path, item]));
	const planSkipped = new Map(plan.skipped.map((item) => [item.path, item.reason]));
	// 一次批量引用扫描替代每张图各扫全库；批量失败时回退到逐图扫描。
	let referenceScans: Map<string, ImageReferenceScanResult>;
	try {
		referenceScans = await findImageReferencesBatch(app, files.map((file) => file.path));
	} catch {
		referenceScans = new Map();
	}
	const items: ConvertibleImage[] = [];
	let processed = 0;
	let next = 0;
	let stopped = false;
	onProgress?.({ processed, total });
	const workers = Array.from({ length: Math.max(1, Math.min(CONVERSION_CONCURRENCY, total || 1)) }, async () => {
		while (!stopped) {
			if (signal?.aborted) return;
			const index = next++;
			if (index >= total) return;
			const file = files[index]!;
			items.push(await estimateOneImage(app, file, normalized, codec, planned.get(file.path), planSkipped.get(file.path), referenceScans.get(file.path)));
			processed += 1;
			onProgress?.({ processed, total, currentPath: file.path });
			// 中止后不再领取新文件，但已开始的编码会自然结束并被计入结果。
			if (signal?.aborted) stopped = true;
		}
	});
	await Promise.all(workers);
	// 同格式是“永远不能转”的噪声：即使绕过候选集调用，也不出现在估算结果里。
	return items.filter((item) => item.blockedReason !== 'same-format').sort((a, b) => a.path.localeCompare(b.path));
}

async function estimateOneImage(app: App, file: TFile, config: ImageConversionConfig, codec: ImageCodec, planned: ImageConvertPlanItem | undefined, planBlockedReason: string | undefined, precomputed?: ImageReferenceScanResult): Promise<ConvertibleImage> {
	const extension = file.extension.toLowerCase();
	const base: ConvertibleImage = {
		path: file.path,
		extension,
		width: 0,
		height: 0,
		oldBytes: file.stat?.size ?? 0,
		newBytes: 0,
		hasAlpha: false,
		referenceCount: 0,
	};
	if ((extension === 'jpeg' ? 'jpg' : extension) === config.target) return { ...base, blockedReason: 'same-format' };
	// 轻量引用预检：数量即“引用处数”，任何无法安全改写的引用风险直接阻断该图。
	try {
		const references = precomputed ?? await findImageReferences(app, file.path);
		if (!references.ok) return { ...base, blockedReason: references.reason };
		base.referenceCount = references.totalLiveRefs;
	} catch {
		return { ...base, blockedReason: 'unsupported-source' };
	}
	if (planBlockedReason) return { ...base, blockedReason: planBlockedReason };
	if (!planned) return { ...base, blockedReason: 'unsupported-source' };
	let data: ArrayBuffer;
	try {
		data = await app.vault.readBinary(file);
	} catch {
		return { ...base, blockedReason: '读取文件失败' };
	}
	let decoded: Awaited<ReturnType<ImageCodec['decode']>>;
	try {
		decoded = await codec.decode(data);
	} catch {
		return { ...base, blockedReason: '图片解码失败' };
	}
	if (!decoded.ok) return { ...base, blockedReason: decoded.reason };
	const image = decoded.image;
	try {
		const width = Math.max(0, Math.round(image.width));
		const height = Math.max(0, Math.round(image.height));
		const sized: ConvertibleImage = { ...base, width, height, hasAlpha: Boolean(image.hasAlpha) };
		if (!isWithinPixelLimit(width, height)) return { ...sized, blockedReason: '分辨率超过 40MP' };
		// “跳过透明图”对所有目标格式一致；选白底时 JPG 恒白底，WebP/PNG 也按白底估算体积。
		if (config.alpha === 'skip' && sized.hasAlpha) return { ...sized, blockedReason: 'alpha-skip' };
		const flatten = config.target === 'jpg' || config.alpha === 'flatten';
		let encoded: Awaited<ReturnType<ImageCodec['encode']>>;
		try {
			encoded = await codec.encode(image, config.target, { quality: config.quality / 100, flatten });
		} catch {
			return { ...sized, blockedReason: '图片编码失败' };
		}
		if (!encoded.ok) return { ...sized, blockedReason: encoded.reason };
		return { ...sized, newBytes: encoded.bytes.byteLength };
	} finally {
		codec.release?.(image);
	}
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
