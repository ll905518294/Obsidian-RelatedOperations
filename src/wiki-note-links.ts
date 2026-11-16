import type { App, CachedMetadata, Pos, TFile } from 'obsidian';
import { isExternalLink, isInsideIgnoredRange } from './core-utils.ts';

export interface WikiNoteLink {
	sourcePath: string;
	original: string;
	linkPath: string;
	heading?: string;
	blockId?: string;
	position: Pos;
	file?: TFile;
	reason?: string;
}

export function wikiNoteLinkKey(link: WikiNoteLink) {
	return `${link.sourcePath}\u0000${link.position.start.offset}:${link.position.end.offset}`;
}

export function revalidateWikiNoteLink(app: App, link: WikiNoteLink): WikiNoteLink {
	return { ...link, file: app.metadataCache.getFirstLinkpathDest(link.linkPath, link.sourcePath) ?? undefined };
}

export function findWikiNoteLinks(app: App, files: TFile[] = app.vault.getMarkdownFiles()): WikiNoteLink[] {
	return files.flatMap((file) => {
		const cache = app.metadataCache.getFileCache(file);
		return cache ? findInCache(app, file.path, cache) : [];
	}).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.position.start.offset - b.position.start.offset);
}

function findInCache(app: App, sourcePath: string, cache: CachedMetadata): WikiNoteLink[] {
	return (cache.links ?? []).flatMap((reference) => {
		const original = reference.original;
		if (!original.startsWith('[[') || original.startsWith('![[')) return [];
		const parsed = parseWiki(original);
		if (!parsed || isInsideIgnoredRange(cache, reference.position)) return [];
		const resolved = app.metadataCache.getFirstLinkpathDest(parsed.path, sourcePath);
		if (!resolved || !resolved.path.toLowerCase().endsWith('.md')) return [];
		return [{ sourcePath, original, linkPath: parsed.path, heading: parsed.heading, blockId: parsed.blockId, position: reference.position, file: resolved }];
	});
}

export function wikiNoteLinkOffset(content: string, link: WikiNoteLink, allowFallback = true) {
	const start = link.position.start.offset, end = link.position.end.offset;
	if (start >= 0 && end > start && end <= content.length && content.slice(start, end) === link.original) return { start, end };
	if (!allowFallback) return null;
	const found = content.indexOf(link.original);
	return found < 0 ? null : { start: found, end: found + link.original.length };
}

export function convertWikiNoteLink(link: WikiNoteLink): string | null {
	if (!link.file || link.reason) return null;
	const parsed = parseWiki(link.original);
	if (!parsed) return null;
	const target = escapeDestination(link.file.path);
	// A link can carry both a heading and a block id (`[[a#标题^块id]]`); the
	// block id refines the heading anchor instead of replacing it. Building the
	// fragment conditionally keeps the heading when both are present.
	let fragment = '';
	if (parsed.heading) fragment += `#${escapeDestination(parsed.heading)}`;
	if (parsed.blockId) fragment += `#^${escapeDestination(parsed.blockId)}`;
	const url = fragment ? `<${target}${fragment}>` : `<${target}>`;
	const alias = parsed.alias;
	let text: string;
	if (alias) text = alias;
	else if (parsed.heading) text = `${parsed.path} > ${parsed.heading}`;
	else if (parsed.blockId) text = `${parsed.path} > ^${parsed.blockId}`;
	else text = parsed.path;
	return `[${escapeLinkText(text)}](${url})`;
}

// Markdown link destinations are URI-decoded by Obsidian and by this repo's own
// link scans, so a raw `%` would corrupt headings such as `100%（完成）`. `#`
// would end the fragment and `<`/`>` would end the `<...>` destination. Spaces,
// slashes and non-ASCII stay literal for readability.
function escapeDestination(value: string) {
	return value.replaceAll('%', '%25').replaceAll('#', '%23').replaceAll('<', '%3C').replaceAll('>', '%3E');
}

export function replaceWikiNoteLinks(content: string, links: WikiNoteLink[]) {
	let converted = 0;
	let skipped = 0;
	const accepted: Array<{ start: number; end: number; replacement: string }> = [];
	let boundary = content.length;
	for (const link of [...links].sort((a, b) => b.position.start.offset - a.position.start.offset)) {
		const start = link.position.start.offset;
		const end = link.position.end.offset;
		const replacement = convertWikiNoteLink(link);
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

function parseWiki(original: string): { path: string; heading?: string; blockId?: string; alias?: string } | null {
	const match = /^\[\[([^\]]+)\]\]$/.exec(original);
	if (!match) return null;
	const inner = match[1]!;
	const parts = splitPipeParts(inner);
	const target = (parts.shift() ?? '').trim();
	if (!target) return null;
	let rest = target;
	let blockId: string | undefined;
	const blockMatch = rest.match(/\^(.+)$/);
	if (blockMatch) {
		blockId = blockMatch[1]!.trim();
		rest = rest.slice(0, rest.lastIndexOf('^')).trim();
	}
	let path = rest;
	let heading: string | undefined;
	const hashMatch = rest.match(/#(.+)$/);
	if (hashMatch) {
		heading = hashMatch[1]!.trim();
		path = rest.slice(0, rest.indexOf('#')).trim();
	}
	if (!path) return null;
	if (isExternalLink(path)) return null;
	return { path, heading, blockId, alias: parts.join('|').trim() || undefined };
}

// Inside tables Obsidian writes the alias separator as `\|`. Its own parser
// treats it as the separator and drops the backslash from the target
// (`[[Note\|Alias]]` → `Note`), so normalize before splitting.
function splitPipeParts(value: string) {
	return value.replaceAll('\\|', '|').split('|');
}

function escapeLinkText(value: string) {
	return value
		.replaceAll('\\', '\\\\')
		.replaceAll('[', '\\[')
		.replaceAll(']', '\\]')
		.replaceAll('|', '\\|');
}

/*
 * 批量入口专用：调用方已经取到 cache 时只解析这一个文件。返回顺序与
 * findWikiNoteLinks 的单文件结果一致，跨文件排序由批量入口统一完成。
 */
export function collectWikiNoteLinks(app: App, sourcePath: string, cache: CachedMetadata): WikiNoteLink[] {
	return findInCache(app, sourcePath, cache);
}
