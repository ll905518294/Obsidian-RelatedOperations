import type { App, CachedMetadata, Pos, TFile } from 'obsidian';

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

const EXTERNAL_LINK_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function brokenLinkKey(link: BrokenImageLink) {
	return `${link.sourcePath}\u0000${link.position.start.offset}:${link.position.end.offset}`;
}

export function findBrokenImageLinks(app: App, imageExtensions: string, files: TFile[] = app.vault.getMarkdownFiles()): BrokenImageLink[] {
	const extensions = parseImageExtensions(imageExtensions);
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
	let result = content;
	let removed = 0;
	let skipped = 0;
	for (const link of [...links].sort((a, b) => b.position.start.offset - a.position.start.offset)) {
		const start = link.position.start.offset;
		const end = link.position.end.offset;
		if (start < 0 || end <= start || end > result.length) {
			skipped++;
			continue;
		}
		if (!matchesCachedReference(result.slice(start, end), link.original)) {
			skipped++;
			continue;
		}

		const lineStart = result.lastIndexOf('\n', start - 1) + 1;
		const lineEnd = result.indexOf('\n', end) === -1 ? result.length : result.indexOf('\n', end);
		const isOnlyContentOnLine = result.slice(lineStart, start).trim() === '' && result.slice(end, lineEnd).trim() === '';
		const removeStart = isOnlyContentOnLine ? lineStart : start;
		const removeEnd = isOnlyContentOnLine
			? lineEnd + (lineEnd < result.length ? 1 : 0)
			: end;
		result = result.slice(0, removeStart) + result.slice(removeEnd);
		removed++;
	}
	return { content: result, removed, skipped };
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
			result.failed.push({ path: sourcePath, reason: `${grouped.length} 条链接：${reasonFor(error)}` });
		}
	}
	return result;
}

function matchesCachedReference(actual: string, original: string) {
	return actual === original || actual === `!${original}` || `!${actual}` === original;
}

function isInsideIgnoredRange(cache: CachedMetadata, position: Pos) {
	const frontmatter = cache.frontmatterPosition;
	if (frontmatter && containsPosition(frontmatter, position)) return true;
	return (cache.sections ?? []).some((section) => section.type === 'code' && containsPosition(section.position, position));
}

function containsPosition(range: Pos, position: Pos) {
	return position.start.offset >= range.start.offset && position.end.offset <= range.end.offset;
}

function targetPath(link: string) {
	return link.split('#', 1)[0] ?? '';
}

function isExternalLink(path: string) {
	return EXTERNAL_LINK_PATTERN.test(path);
}

function parseImageExtensions(value: string) {
	return new Set(
		value
			.split(/[,，\s]+/)
			.map((extension) => extension.trim().replace(/^\./, '').toLowerCase())
			.filter((extension) => /^[a-z0-9]+$/.test(extension)),
	);
}

function fileExtension(path: string) {
	const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
	const dot = name.lastIndexOf('.');
	return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function reasonFor(error: unknown) {
	return error instanceof Error ? error.message : '未知错误';
}
