import type { App, CachedMetadata, Pos, TFile } from 'obsidian';
import { errorMessage, isCaseSensitiveFileSystem, isExternalLink, isInsideIgnoredRange, parseExtensions, removeCachedLinkRanges } from './core-utils.ts';

export interface BrokenNoteLink {
	sourcePath: string;
	original: string;
	linkPath: string;
	position: Pos;
	syntax: 'wiki' | 'markdown';
}

export function brokenNoteLinkKey(link: BrokenNoteLink) {
	return `${link.sourcePath}\u0000${link.position.start.offset}:${link.position.end.offset}`;
}

export function findBrokenNoteLinks(app: App, imageExtensions: string, files: TFile[] = app.vault.getMarkdownFiles()): BrokenNoteLink[] {
	const images = parseExtensions(imageExtensions);
	return files.flatMap((file) => {
		const cache = app.metadataCache.getFileCache(file);
		return cache ? findBrokenNoteLinksInCache(file.path, cache, images, app) : [];
	}).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.position.start.offset - b.position.start.offset);
}

function findBrokenNoteLinksInCache(sourcePath: string, cache: CachedMetadata, images: Set<string>, app: App): BrokenNoteLink[] {
  return (cache.links ?? []).flatMap((reference) => {
    if (reference.original.startsWith('!')) return [];
    const parsed = parseLink(reference.original, reference.link);
		if (!parsed || isExternalLink(parsed.path) || isImageOrAttachment(parsed.path, images) || isInsideIgnoredRange(cache, reference.position)) return [];
		if (app.metadataCache.getFirstLinkpathDest(parsed.path, sourcePath)) return [];
		return [{ sourcePath, original: reference.original, linkPath: parsed.path, position: reference.position, syntax: parsed.syntax }];
	});
}

export function removeBrokenNoteLinks(content: string, links: BrokenNoteLink[]) {
	return removeCachedLinkRanges(content, links, (actual, original) => actual === original);
}

export function findBrokenNoteLinkOffset(content: string, link: BrokenNoteLink) {
	const start = link.position.start.offset; const end = link.position.end.offset;
	return start >= 0 && end > start && end <= content.length && content.slice(start, end) === link.original ? { start, end } : null;
}

export async function removeSelectedBrokenNoteLinks(app: App, links: BrokenNoteLink[]) {
	const result = { removed: 0, skipped: 0, failed: [] as Array<{ path: string; reason: string }> };
	const grouped = new Map<string, BrokenNoteLink[]>();
	for (const link of links) {
		if (app.metadataCache.getFirstLinkpathDest(link.linkPath, link.sourcePath)) {
			result.skipped++;
			continue;
		}
		const group = grouped.get(link.sourcePath) ?? [];
		group.push(link);
		grouped.set(link.sourcePath, group);
	}
	for (const [path, selected] of grouped) {
		const file = app.vault.getFileByPath(path);
		if (!file || file.extension.toLowerCase() !== 'md') { result.failed.push({ path, reason: `${selected.length} 条链接：源笔记不存在或不是 Markdown` }); continue; }
		try { await app.vault.process(file, (content) => { const changed = removeBrokenNoteLinks(content, selected); result.removed += changed.removed; result.skipped += changed.skipped; return changed.content; }); }
		catch (error) { result.failed.push({ path, reason: `${selected.length} 条链接：${errorMessage(error)}` }); }
	}
	return result;
}

export interface CreateMissingNotesResult {
	created: string[];
	skipped: Array<{ path: string; reason: string }>;
	failed: Array<{ path: string; reason: string }>;
}

export async function createMissingNotes(
	app: App,
	links: BrokenNoteLink[],
	caseSensitive = isCaseSensitiveFileSystem(),
): Promise<CreateMissingNotesResult> {
	const result: CreateMissingNotesResult = { created: [], skipped: [], failed: [] };
	const targets = new Map<string, BrokenNoteLink[]>();
	const sourceReads = new Map<string, Promise<string>>();
	const knownPaths = createPathIndex(app, caseSensitive);
	for (const link of links) {
		const path = missingNotePath(link);
		if (!path) result.skipped.push({ path: link.linkPath, reason: '目标路径无效' });
		else {
			const group = targets.get(path) ?? [];
			group.push(link);
			targets.set(path, group);
		}
	}
	for (const [path, targetLinks] of targets) {
		if (knownPaths.has(path)) {
			result.skipped.push({ path, reason: '目标已存在' });
			continue;
		}
		if (!(await Promise.all(targetLinks.map((link) => isCurrentMissingNoteLink(app, link, sourceReads)))).some(Boolean)) {
			result.skipped.push({ path, reason: '链接已变化或目标已恢复' });
			continue;
		}
		try {
			// slice(0, -1) on a root-level path would become "name without its
			// last character" and create a bogus folder; only split when a real
			// separator exists.
			const slash = path.lastIndexOf('/');
			const parent = slash > 0 ? path.slice(0, slash) : '';
			if (parent) {
				let current = '';
				for (const segment of parent.split('/')) {
					current = current ? `${current}/${segment}` : segment;
					if (!knownPaths.has(current)) {
						await app.vault.createFolder(current);
						knownPaths.add(current);
					}
				}
			}
			if (knownPaths.has(path)) {
				result.skipped.push({ path, reason: '目标已存在' });
				continue;
			}
			await app.vault.create(path, '');
			knownPaths.add(path);
			result.created.push(path);
		} catch (error) {
			result.failed.push({ path, reason: errorMessage(error, '创建失败') });
		}
	}
	return result;
}

async function isCurrentMissingNoteLink(app: App, link: BrokenNoteLink, sourceReads: Map<string, Promise<string>>) {
	if (app.metadataCache.getFirstLinkpathDest(link.linkPath, link.sourcePath)) return false;
	const source = app.vault.getFileByPath(link.sourcePath);
	if (!source || source.extension.toLowerCase() !== 'md') return false;
	// Several broken links can share one source; read it once per operation.
	let content = sourceReads.get(link.sourcePath);
	if (!content) {
		content = app.vault.read(source);
		sourceReads.set(link.sourcePath, content);
	}
	try {
		return findBrokenNoteLinkOffset(await content, link) !== null;
	} catch {
		// The source may disappear between the index lookup and the read. Treat
		// it like a changed link so one unreadable note cannot reject the batch.
		return false;
	}
}

function createPathIndex(app: App, caseSensitive: boolean) {
	const paths = new Set<string>();
	const normalize = (path: string) => caseSensitive ? path : path.toLowerCase();
	let loaded = false;
	return {
		has(path: string) {
			if (!loaded) {
				loaded = true;
				for (const file of app.vault.getAllLoadedFiles()) paths.add(normalize(file.path));
			}
			return paths.has(normalize(path));
		},
		add(path: string) {
			paths.add(normalize(path));
		},
	};
}

export function missingNotePath(link: BrokenNoteLink): string | null {
	const encoded = link.linkPath.trim().replaceAll('\\', '/');
	let raw: string;
	try { raw = decodeURIComponent(encoded).replaceAll('\\', '/'); } catch { return null; }
	const parts = raw.split('/');
	if (!raw || raw.startsWith('/') || raw.includes(':') || raw.includes('\0') || parts.some((part, index) => !part.trim() || part === '..' || (part.startsWith('.') && !(index === 0 && part === '.')))) return null;
	const normalized = parts.filter((part) => part !== '.').join('/');
	const sourceDir = link.sourcePath.includes('/') ? link.sourcePath.slice(0, link.sourcePath.lastIndexOf('/')) : '';
	const relative = link.syntax === 'markdown' || !raw.includes('/') || raw.startsWith('./');
	const path = relative && sourceDir ? `${sourceDir}/${normalized}` : normalized;
	return /\.md$/i.test(path) ? path : `${path}.md`;
}

function parseLink(original: string, raw: string): { path: string; syntax: 'wiki' | 'markdown' } | null {
	const syntax = original.startsWith('[[') ? 'wiki' : original.startsWith('[') ? 'markdown' : null;
	if (!syntax) return null;
	const target = raw.split('|', 1)[0] ?? raw;
	const hash = target.search(/[#^]/);
	const path = (hash < 0 ? target : target.slice(0, hash)).trim();
	if (!path) return null;
	return { path, syntax };
}

function isImageOrAttachment(path: string, images: Set<string>) {
	const dot = path.lastIndexOf('.');
	if (dot < 0) return false;
	const extension = path.slice(dot + 1).toLowerCase();
	return extension !== 'md' && (images.has(extension) || KNOWN_IMAGE_EXTENSIONS.has(extension) || KNOWN_ATTACHMENT_EXTENSIONS.has(extension));
}

const KNOWN_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico', 'tif', 'tiff', 'heic', 'heif']);
const KNOWN_ATTACHMENT_EXTENSIONS = new Set([
	'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
	'zip', 'rar', '7z', 'tar', 'gz', 'txt', 'csv', 'json', 'xml',
	'mp3', 'wav', 'ogg', 'm4a', 'mp4', 'mov', 'webm', 'avi',
	// Canvas is a first-class non-Markdown vault file (handled separately by
	// the cleanup scans); it must never be offered as a missing note.
	'canvas',
	// Bases (`.base`) are the same kind of first-class non-Markdown vault file.
	'base',
]);

/*
 * 批量入口专用：调用方已经取到 cache 时只解析这一个文件。返回顺序与
 * findBrokenNoteLinks 的单文件结果一致，跨文件排序由批量入口统一完成。
 */
export function collectBrokenNoteLinks(
	app: App,
	sourcePath: string,
	cache: CachedMetadata,
	images: Set<string>,
): BrokenNoteLink[] {
	return findBrokenNoteLinksInCache(sourcePath, cache, images, app);
}

