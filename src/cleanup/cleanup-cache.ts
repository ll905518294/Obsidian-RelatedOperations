import { TFile, TFolder, type App } from 'obsidian';
import type { BrokenImageLink } from '../broken-image-links';
import type { BrokenNoteLink } from '../broken-note-links';
import type { DuplicateFileGroup } from '../duplicate-files';
import type { NativeImageLink } from '../native-image-links';
import type { WikiNoteLink } from '../wiki-note-links';
import type { CleanupCandidates } from './cleanup-types';

/*
 * data.json 只能保存纯数据：TFile/TFolder 反向持有 vault，直接序列化会抛
 * "Converting circular structure to JSON"。缓存只保留恢复展示所需的路径与
 * 文件属性，恢复时再按路径解析回 Obsidian 文件对象。
 */
export const CLEANUP_CACHE_VERSION = 2;

export interface CachedFileRef {
	path: string;
	size?: number;
	mtime?: number;
}

export interface CachedFolderRef {
	path: string;
}

export type CachedNativeImageLink = Omit<NativeImageLink, 'file'> & { file?: CachedFileRef };
export type CachedWikiNoteLink = Omit<WikiNoteLink, 'file'> & { file?: CachedFileRef };

export interface SerializedCleanupCandidates {
	// 版本标记写进候选数据本身：面板只把 candidates 传给恢复函数，
	// 外层 version 到不了这里，没有这个标记就无法让版本升级真正失效。
	cacheVersion: number;
	images: CachedFileRef[];
	attachments: CachedFileRef[];
	emptyFiles: CachedFileRef[];
	folders: CachedFolderRef[];
	brokenLinks: BrokenImageLink[];
	nativeLinks: CachedNativeImageLink[];
	brokenNoteLinks: BrokenNoteLink[];
	wikiLinks: CachedWikiNoteLink[];
	duplicates: DuplicateFileGroup[];
	duplicateWarnings: Array<{ path: string; reason: string }>;
	convertibleImages: CachedFileRef[];
}

export interface OrphanCleanupCache {
	version: number;
	scannedAt: string;
	candidates: SerializedCleanupCandidates;
	settingsSnapshot: {
		orphanImageExtensions: string;
		orphanIgnoredFolders: string;
	};
}

export function createCleanupCache(
	scannedAt: string,
	candidates: CleanupCandidates,
	settingsSnapshot: OrphanCleanupCache['settingsSnapshot'],
): OrphanCleanupCache {
	return {
		version: CLEANUP_CACHE_VERSION,
		scannedAt,
		candidates: serializeCleanupCandidates(candidates),
		settingsSnapshot: {
			orphanImageExtensions: settingsSnapshot.orphanImageExtensions,
			orphanIgnoredFolders: settingsSnapshot.orphanIgnoredFolders,
		},
	};
}

export function serializeCleanupCandidates(candidates: CleanupCandidates): SerializedCleanupCandidates {
	return {
		cacheVersion: CLEANUP_CACHE_VERSION,
		images: candidates.images.map(toFileRef),
		attachments: candidates.attachments.map(toFileRef),
		emptyFiles: candidates.emptyFiles.map(toFileRef),
		folders: candidates.folders.map((folder) => ({ path: folder.path })),
		brokenLinks: candidates.brokenLinks.map(copyBrokenLink),
		nativeLinks: candidates.nativeLinks.map(serializeNativeLink),
		brokenNoteLinks: candidates.brokenNoteLinks.map(copyBrokenNoteLink),
		wikiLinks: candidates.wikiLinks.map(serializeWikiLink),
		duplicates: candidates.duplicates.map(copyDuplicateGroup),
		duplicateWarnings: candidates.duplicateWarnings.map((warning) => ({ path: warning.path, reason: warning.reason })),
		// 转换候选属于临时状态，与旧缓存保持一致不写入 data.json。
		convertibleImages: [],
	};
}

/*
 * 旧缓存可能来自更早的版本，字段缺失、类型错误或文件已删除都不能让面板
 * 崩溃；这里逐项校验，可用部分尽量恢复，无法解析的文件直接丢弃。
 */
export function restoreCleanupCandidates(app: Pick<App, 'vault'>, raw: unknown): CleanupCandidates {
	// 兼容“整个缓存对象”和“只传 candidates”两种旧调用方式。
	const record = isRecord(raw) ? raw : {};
	// 外层 version 存在于整份缓存里；cacheVersion 存在于候选数据里。
	// 只认明确的数字版本；没有标记的旧数据按兼容路径尽力恢复。
	const version = finiteNumber(record.version) ?? finiteNumber(record.cacheVersion);
	if (version !== undefined && version !== CLEANUP_CACHE_VERSION) return emptyCandidates();
	const source = isRecord(record.candidates) ? record.candidates : record;
	try {
		return {
			images: resolveFiles(app, source.images),
			attachments: resolveFiles(app, source.attachments),
			// 空文件候选取决于当前内容：缓存后又被写入内容的文件不能继续
			// 以“空文件”身份出现，否则会误导清理。
			emptyFiles: resolveFiles(app, source.emptyFiles, true),
			folders: resolveFolders(app, source.folders),
			brokenLinks: restoreBrokenLinks(source.brokenLinks),
			nativeLinks: restoreNativeLinks(app, source.nativeLinks),
			brokenNoteLinks: restoreBrokenNoteLinks(source.brokenNoteLinks),
			wikiLinks: restoreWikiLinks(app, source.wikiLinks),
			duplicates: restoreDuplicates(app, source.duplicates),
			duplicateWarnings: restoreWarnings(source.duplicateWarnings),
			convertibleImages: [],
		};
	} catch {
		return emptyCandidates();
	}
}

function emptyCandidates(): CleanupCandidates {
	return {
		images: [],
		attachments: [],
		emptyFiles: [],
		folders: [],
		brokenLinks: [],
		nativeLinks: [],
		brokenNoteLinks: [],
		wikiLinks: [],
		duplicates: [],
		duplicateWarnings: [],
		convertibleImages: [],
	};
}

function toFileRef(file: TFile): CachedFileRef {
	const ref: CachedFileRef = { path: file.path };
	const size = finiteNumber(file.stat?.size);
	if (size !== undefined) ref.size = size;
	const mtime = finiteNumber(file.stat?.mtime);
	if (mtime !== undefined) ref.mtime = mtime;
	return ref;
}

function copyBrokenLink(link: BrokenImageLink): BrokenImageLink {
	return {
		sourcePath: link.sourcePath,
		original: link.original,
		linkPath: link.linkPath,
		position: copyPosition(link.position),
	};
}

function copyBrokenNoteLink(link: BrokenNoteLink): BrokenNoteLink {
	return { ...copyBrokenLink(link), syntax: link.syntax };
}

function serializeNativeLink(link: NativeImageLink): CachedNativeImageLink {
	const { file, ...rest } = link;
	return file ? { ...rest, position: copyPosition(rest.position), file: toFileRef(file) } : { ...rest, position: copyPosition(rest.position) };
}

function serializeWikiLink(link: WikiNoteLink): CachedWikiNoteLink {
	const { file, ...rest } = link;
	return file ? { ...rest, position: copyPosition(rest.position), file: toFileRef(file) } : { ...rest, position: copyPosition(rest.position) };
}

function copyPosition(position: BrokenImageLink['position']): BrokenImageLink['position'] {
	return { start: { ...position.start }, end: { ...position.end } };
}

function copyDuplicateGroup(group: DuplicateFileGroup): DuplicateFileGroup {
	return {
		hash: group.hash,
		size: group.size,
		files: group.files.map((file) => ({
			path: file.path,
			extension: typeof file.extension === 'string' ? file.extension : '',
			size: finiteNumber(file.size) ?? 0,
			mtime: finiteNumber(file.mtime) ?? 0,
			referenced: file.referenced === true,
			// 旧数据/测试夹具可能只有路径，缺字段时补安全默认值。
			referencingNotes: Array.isArray(file.referencingNotes) ? [...file.referencingNotes] : [],
		})),
	};
}

function resolveFiles(app: Pick<App, 'vault'>, value: unknown, requireUnchanged = false): TFile[] {
	return asArray(value).flatMap((entry) => {
		const file = resolveFile(app, entry);
		if (!file) return [];
		if (requireUnchanged && !matchesCachedStat(file, entry)) return [];
		return [file];
	});
}

function matchesCachedStat(file: TFile, value: unknown): boolean {
	if (!isRecord(value)) return true;
	const size = finiteNumber(value.size);
	const mtime = finiteNumber(value.mtime);
	if (size === undefined || mtime === undefined) return true;
	return file.stat?.size === size && file.stat?.mtime === mtime;
}

function resolveFolders(app: Pick<App, 'vault'>, value: unknown): TFolder[] {
	return asArray(value).flatMap((entry) => {
		const target = resolveAbstractFile(app, entry);
		return target instanceof TFolder ? [target] : [];
	});
}

function resolveFile(app: Pick<App, 'vault'>, value: unknown): TFile | undefined {
	const target = resolveAbstractFile(app, value);
	return target instanceof TFile ? target : undefined;
}

function resolveAbstractFile(app: Pick<App, 'vault'>, value: unknown): unknown {
	const path = pathOf(value);
	if (!path) return undefined;
	try {
		return app.vault.getAbstractFileByPath(path) ?? undefined;
	} catch {
		return undefined;
	}
}

function pathOf(value: unknown): string | undefined {
	if (typeof value === 'string') return value || undefined;
	if (!isRecord(value)) return undefined;
	return typeof value.path === 'string' && value.path ? value.path : undefined;
}

function restoreBrokenLinks(value: unknown): BrokenImageLink[] {
	return asArray(value).flatMap((entry) => {
		const link = readLinkBase(entry);
		return link ? [link] : [];
	});
}

function restoreBrokenNoteLinks(value: unknown): BrokenNoteLink[] {
	return asArray(value).flatMap((entry) => {
		const link = readLinkBase(entry);
		if (!link) return [];
		return [{ ...link, syntax: isRecord(entry) && entry.syntax === 'markdown' ? 'markdown' : 'wiki' }];
	});
}

function restoreNativeLinks(app: Pick<App, 'vault'>, value: unknown): NativeImageLink[] {
	return asArray(value).flatMap((entry) => {
		const link = readLinkBase(entry);
		if (!link || !isRecord(entry)) return [];
		const restored: NativeImageLink = { ...link };
		const reason = optionalString(entry.reason);
		if (reason) restored.reason = reason;
		const file = resolveFile(app, entry.file);
		if (file) restored.file = file;
		return [restored];
	});
}

function restoreWikiLinks(app: Pick<App, 'vault'>, value: unknown): WikiNoteLink[] {
	return asArray(value).flatMap((entry) => {
		const link = readLinkBase(entry);
		if (!link || !isRecord(entry)) return [];
		const restored: WikiNoteLink = { ...link };
		const heading = optionalString(entry.heading);
		if (heading) restored.heading = heading;
		const blockId = optionalString(entry.blockId);
		if (blockId) restored.blockId = blockId;
		const reason = optionalString(entry.reason);
		if (reason) restored.reason = reason;
		const file = resolveFile(app, entry.file);
		if (file) restored.file = file;
		return [restored];
	});
}

function readLinkBase(value: unknown): BrokenImageLink | undefined {
	if (!isRecord(value)) return undefined;
	const sourcePath = optionalString(value.sourcePath);
	const original = optionalString(value.original);
	const linkPath = optionalString(value.linkPath);
	const position = readPosition(value.position);
	if (!sourcePath || original === undefined || linkPath === undefined || !position) return undefined;
	return { sourcePath, original, linkPath, position };
}

function readPosition(value: unknown): BrokenImageLink['position'] | undefined {
	if (!isRecord(value)) return undefined;
	const start = readLocation(value.start);
	const end = readLocation(value.end);
	return start && end ? { start, end } : undefined;
}

function readLocation(value: unknown): { line: number; col: number; offset: number } | undefined {
	if (!isRecord(value)) return undefined;
	const offset = finiteNumber(value.offset);
	if (offset === undefined) return undefined;
	return {
		line: finiteNumber(value.line) ?? 0,
		col: finiteNumber(value.col) ?? finiteNumber(value.column) ?? 0,
		offset,
	};
}

function restoreDuplicates(app: Pick<App, 'vault'>, value: unknown): DuplicateFileGroup[] {
	return asArray(value).flatMap((group) => {
		if (!isRecord(group)) return [];
		const hash = optionalString(group.hash);
		const size = finiteNumber(group.size);
		if (!hash || size === undefined) return [];
		const files = asArray(group.files).flatMap((entry) => {
			if (!isRecord(entry)) return [];
			const path = optionalString(entry.path);
			if (!path) return [];
			// 缓存只保存路径与尺寸；按当前文件重新校验，已删除或内容
			// 已变化的成员不能继续留在“重复文件”分组里。
			const file = resolveFile(app, entry);
			if (!file) return [];
			const cachedSize = finiteNumber(entry.size) ?? 0;
			const cachedMtime = finiteNumber(entry.mtime) ?? 0;
			if (file.stat?.size !== cachedSize || file.stat?.mtime !== cachedMtime) return [];
			return [{
				path,
				extension: optionalString(entry.extension) ?? '',
				size: cachedSize,
				mtime: cachedMtime,
				referenced: entry.referenced === true,
				referencingNotes: asArray(entry.referencingNotes).filter((note): note is string => typeof note === 'string'),
			}];
		});
		return files.length > 1 ? [{ hash, size, files }] : [];
	});
}

function restoreWarnings(value: unknown): Array<{ path: string; reason: string }> {
	return asArray(value).flatMap((entry) => {
		if (!isRecord(entry)) return [];
		const path = optionalString(entry.path);
		const reason = optionalString(entry.reason);
		return path && reason ? [{ path, reason }] : [];
	});
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
