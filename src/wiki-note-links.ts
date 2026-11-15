import type { App, CachedMetadata, Pos, TFile } from 'obsidian';

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
	const target = link.file.path;
	let url = `<${target}>`;
	if (parsed.heading) url = `<${target}#${parsed.heading}>`;
	if (parsed.blockId) url = `<${target}#^${parsed.blockId}>`;
	const alias = parsed.alias;
	let text: string;
	if (alias) text = alias;
	else if (parsed.heading) text = `${parsed.path} > ${parsed.heading}`;
	else if (parsed.blockId) text = `${parsed.path} > ^${parsed.blockId}`;
	else text = parsed.path;
	return `[${text}](${url})`;
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
	const parts = inner.split('|');
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
	if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path)) return null;
	return { path, heading, blockId, alias: parts[0]?.trim() || undefined };
}

function isInsideIgnoredRange(cache: CachedMetadata, position: Pos) {
	const frontmatter = cache.frontmatterPosition;
	return (frontmatter && contains(frontmatter, position)) || (cache.sections ?? []).some((section) => section.type === 'code' && contains(section.position, position));
}

function contains(a: Pos, b: Pos) {
	return b.start.offset >= a.start.offset && b.end.offset <= a.end.offset;
}
