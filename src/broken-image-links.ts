import type { App, CachedMetadata, Pos, TFile } from 'obsidian';
import { errorMessage, isExternalLink, isInsideIgnoredRange, parseExtensions, removeCachedLinkRanges } from './core-utils.ts';

export interface BrokenImageLink {
	sourcePath: string;
	original: string;
	linkPath: string;
	position: Pos;
}

interface RemoveBrokenLinksResult {
	content: string;
	removed: number;
	skipped: number;
}

export function brokenLinkKey(link: BrokenImageLink): string {
	return `${link.sourcePath}\u0000${link.position.start.offset}:${link.position.end.offset}`;
}

export function findBrokenImageLinks(app: App, imageExtensions: string, files: TFile[] = app.vault.getMarkdownFiles()): BrokenImageLink[] {
	const extensions = parseExtensions(imageExtensions);
	return files
		.flatMap((file) => {
			const cache = app.metadataCache.getFileCache(file);
			return cache ? findBrokenImageLinksInCache(file.path, cache, extensions, app) : [];
		})
		.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.position.start.offset - b.position.start.offset);
}

function findBrokenImageLinksInCache(
	sourcePath: string,
	cache: CachedMetadata,
	extensions: Set<string>,
	app: App,
): BrokenImageLink[] {
	return [...cache.embeds ?? [], ...cache.links ?? []].flatMap((reference) => {
		const linkPath = targetPath(reference.link);
		const extension = fileExtension(linkPath);
		if (!extensions.has(extension) || isExternalLink(linkPath)) return [];
		if (isInsideIgnoredRange(cache, reference.position)) return [];
		if (app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath)) return [];
		return [{
			sourcePath,
			original: reference.original,
			linkPath,
			position: reference.position,
		}];
	});
}

export function removeBrokenImageLinks(content: string, links: BrokenImageLink[]): RemoveBrokenLinksResult {
	return removeCachedLinkRanges(content, links, (actual, original) => actual === original);
}

export function findBrokenLinkOffset(
	content: string,
	link: BrokenImageLink,
): { start: number; end: number } | null {
	const start = link.position.start.offset;
	const end = link.position.end.offset;
	if (start >= 0 && end > start && end <= content.length && content.slice(start, end) === link.original) {
		return { start, end };
	}

	const isBangLink = link.original.startsWith('!');
	let match: { start: number; end: number } | null = null;
	let matches = 0;
	for (let found = content.indexOf(link.original); found >= 0; found = content.indexOf(link.original, found + 1)) {
		// A plain broken link (`[[x.png]]`) must not be relocated inside a live
		// image embed (`![[x.png]]`), otherwise removal would corrupt the image.
		const precededByBang = found > 0 && content.charCodeAt(found - 1) === 0x21;
		if (!isBangLink && precededByBang) continue;
		matches++;
		// Guessing between identical occurrences could target the wrong link;
		// let the caller rescan when the cached position is stale.
		if (matches > 1) return null;
		match = { start: found, end: found + link.original.length };
	}
	return match;
}

export async function removeSelectedBrokenLinks(
	app: App,
	links: BrokenImageLink[],
): Promise<{ removed: number; skipped: number; failed: Array<{ path: string; reason: string }> }> {
	const result = { removed: 0, skipped: 0, failed: [] as Array<{ path: string; reason: string }> };
	const linksBySource = new Map<string, BrokenImageLink[]>();
	for (const link of links) {
		if (app.metadataCache.getFirstLinkpathDest(link.linkPath, link.sourcePath)) {
			result.skipped++;
			continue;
		}
		const grouped = linksBySource.get(link.sourcePath) ?? [];
		grouped.push(link);
		linksBySource.set(link.sourcePath, grouped);
	}

	for (const [sourcePath, grouped] of linksBySource) {
		const file = app.vault.getFileByPath(sourcePath);
		if (!file || file.extension.toLowerCase() !== 'md') {
			result.failed.push({ path: sourcePath, reason: `${grouped.length} 条链接：源笔记不存在` });
			continue;
		}
		try {
			await app.vault.process(file, (content) => {
				const changed = removeBrokenImageLinks(content, grouped);
				result.removed += changed.removed;
				result.skipped += changed.skipped;
				return changed.content;
			});
		} catch (error) {
			result.failed.push({ path: sourcePath, reason: `${grouped.length} 条链接：${errorMessage(error)}` });
		}
	}
	return result;
}

function targetPath(link: string) {
	return link.split('#', 1)[0] ?? '';
}

function fileExtension(path: string) {
	const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
	const dot = name.lastIndexOf('.');
	return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/*
 * 批量入口专用：调用方已经取到 cache 时只解析这一个文件，不再重复查询
 * metadataCache。返回顺序与 findBrokenImageLinks 的单文件结果一致，
 * 跨文件排序由批量入口统一完成。
 */
export function collectBrokenImageLinks(
	app: App,
	sourcePath: string,
	cache: CachedMetadata,
	extensions: Set<string>,
): BrokenImageLink[] {
	return findBrokenImageLinksInCache(sourcePath, cache, extensions, app);
}
