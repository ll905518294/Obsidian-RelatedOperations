import type { App, CachedMetadata, Pos, TFile } from 'obsidian';

export interface NativeImageLink {
	sourcePath: string;
	original: string;
	linkPath: string;
	position: Pos;
	file?: TFile;
	reason?: string;
}

export function nativeImageLinkKey(link: NativeImageLink) {
	return `${link.sourcePath}\u0000${link.position.start.offset}:${link.position.end.offset}`;
}

export function revalidateNativeImageLink(app: App, link: NativeImageLink): NativeImageLink {
	return { ...link, file: app.metadataCache.getFirstLinkpathDest(link.linkPath, link.sourcePath) ?? undefined };
}

export function findNativeImageLinks(app: App, imageExtensions: string, files: TFile[] = app.vault.getMarkdownFiles()): NativeImageLink[] {
	const extensions = new Set(imageExtensions.split(/[,，\s]+/).map((x) => x.replace(/^\./, '').toLowerCase()).filter(Boolean));
	return files.flatMap((file) => {
		const cache = app.metadataCache.getFileCache(file);
		return cache ? findInCache(app, file.path, cache, extensions) : [];
	}).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.position.start.offset - b.position.start.offset);
}

function findInCache(app: App, sourcePath: string, cache: CachedMetadata, extensions: Set<string>) {
	return (cache.embeds ?? []).flatMap((reference) => {
		if (!reference.original.startsWith('![[') || isIgnored(cache, reference.position)) return [];
		const parsed = parseNative(reference.original);
		if (!parsed) return [];
		const linkPath = parsed.target.split('#', 1)[0] ?? '';
		const extension = linkPath.slice(linkPath.lastIndexOf('.') + 1).toLowerCase();
		if (!extensions.has(extension)) return [];
		const file = app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath) ?? undefined;
		return [{ sourcePath, original: reference.original, linkPath, position: reference.position, file, reason: parsed.reason }];
	});
}

export function nativeImageLinkOffset(content: string, link: NativeImageLink, allowFallback = true) {
	const start = offsetOf(link.position.start.offset), end = offsetOf(link.position.end.offset);
	if (start >= 0 && end > start && end <= content.length && content.slice(start, end) === link.original) return { start, end };
	if (!allowFallback) return null;
	const found = content.indexOf(link.original);
	return found < 0 ? null : { start: found, end: found + link.original.length };
}

export function convertNativeImageLink(link: NativeImageLink): string | null {
	if (!link.file || link.reason) return null;
	const parsed = parseNative(link.original);
	if (!parsed) return null;
	const alt = parsed.alias ? escapeAltText(parsed.alias) : '';
	return `![${alt}](<${escapeDestination(link.file.path)}>)`;
}

export function replaceNativeImageLinks(content: string, links: NativeImageLink[]) {
	let converted = 0;
	let skipped = 0;
	// Replacements are collected right to left so positions stay valid, then the
	// note is rebuilt once instead of copying the whole string per link.
	const accepted: Array<{ start: number; end: number; replacement: string }> = [];
	let boundary = content.length;
	for (const link of [...links].sort((a, b) => offsetOf(b.position.start.offset) - offsetOf(a.position.start.offset))) {
		const start = offsetOf(link.position.start.offset);
		const end = offsetOf(link.position.end.offset);
		const replacement = convertNativeImageLink(link);
		// `end > boundary` rejects a second link that overlaps one already accepted
		// above it (duplicate or nested ranges), matching the sequential result.
		if (!replacement || start < 0 || end <= start || end > content.length || end > boundary || content.slice(start, end) !== link.original) {
			skipped++;
			continue;
		}
		accepted.push({ start, end, replacement });
		boundary = start;
		converted++;
	}
	if (!accepted.length) return { content, converted, skipped };
	accepted.reverse();
	const parts: string[] = [];
	let cursor = 0;
	for (const item of accepted) {
		parts.push(content.slice(cursor, item.start), item.replacement);
		cursor = item.end;
	}
	parts.push(content.slice(cursor));
	return { content: parts.join(''), converted, skipped };
}

function parseNative(original: string): { target: string; alias: string; reason?: string } | null {
	const match = /^!\[\[([^\]]+)\]\]$/.exec(original);
	if (!match) return null;
	const parts = splitPipeParts(match[1]!);
	const target = parts.shift()!.trim();
	const extras = parts.map((part) => part.trim()).filter(Boolean);
	if (extras.some((part) => /\d+x\d+/i.test(part) || /^\d+(?=\s|$)/.test(part))) return { target, alias: '', reason: '包含尺寸参数' };
	return { target, alias: extras.join('|') };
}

// Obsidian's table syntax escapes the alias separator as `\|`; the cache keeps
// the raw `original`, so normalize it before splitting and unescape content.
function splitPipeParts(value: string) {
	return value.replaceAll('\\|', '|').split('|');
}

function escapeAltText(value: string) {
	return value
		.replaceAll('\\', '\\\\')
		.replaceAll('[', '\\[')
		.replaceAll(']', '\\]')
		.replaceAll('|', '\\|');
}

// Markdown destinations are URI-decoded by Obsidian and by this repo's own
// link scans, so a literal `%` would be read as an escape, `#` would start a
// fragment, and `<`/`>` would close the `<...>` destination. Spaces, slashes
// and non-ASCII stay literal for readability, matching the wiki-link converter.
function escapeDestination(value: string) {
	return value.replaceAll('%', '%25').replaceAll('#', '%23').replaceAll('<', '%3C').replaceAll('>', '%3E');
}

function isIgnored(cache: CachedMetadata, position: Pos) {
	const frontmatter = cache.frontmatterPosition;
	if (frontmatter && contains(frontmatter, position)) return true;
	return (cache.sections ?? []).some((section) => section.type === 'code' && contains(section.position, position));
}

function contains(range: Pos, position: Pos) {
	return offsetOf(position.start.offset) >= offsetOf(range.start.offset) && offsetOf(position.end.offset) <= offsetOf(range.end.offset);
}

function offsetOf(value: number | { line: number; ch: number }) {
	return typeof value === 'number' ? value : -1;
}

/*
 * 与 findNativeImageLinks 内部的扩展名解析保持一致：它比通用的
 * parseExtensions 宽松，会保留 `x-raw` 这类含非字母数字字符的扩展名。
 * 批量入口复用这一段，避免四个扫描器对同一份配置得出不同的扩展名集合。
 */
export function nativeImageExtensionSet(imageExtensions: string): Set<string> {
	return new Set(imageExtensions.split(/[,，\s]+/).map((x) => x.replace(/^\./, '').toLowerCase()).filter(Boolean));
}

/*
 * 批量入口专用：调用方已经取到 cache 时只解析这一个文件。返回顺序与
 * findNativeImageLinks 的单文件结果一致，跨文件排序由批量入口统一完成。
 */
export function collectNativeImageLinks(
	app: App,
	sourcePath: string,
	cache: CachedMetadata,
	extensions: Set<string>,
): NativeImageLink[] {
	return findInCache(app, sourcePath, cache, extensions);
}
