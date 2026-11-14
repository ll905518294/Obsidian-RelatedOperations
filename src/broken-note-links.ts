import type { App, CachedMetadata, Pos, TFile } from 'obsidian';
import { removeCachedLinkRanges } from './core-utils.ts';

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
		if (!parsed || isExternal(parsed.path) || isImageOrAttachment(parsed.path, images) || isInsideIgnoredRange(cache, reference.position)) return [];
		if (app.metadataCache.getFirstLinkpathDest(parsed.path, sourcePath)) return [];
		return [{ sourcePath, original: reference.original, linkPath: parsed.path, position: reference.position, syntax: parsed.syntax as 'wiki' | 'markdown' }];
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
		(grouped.get(link.sourcePath) ?? (grouped.set(link.sourcePath, []), grouped.get(link.sourcePath)!)).push(link);
	}
	for (const [path, selected] of grouped) {
		const file = app.vault.getFileByPath(path);
		if (!file) { result.failed.push({ path, reason: `${selected.length} 条链接：源笔记不存在` }); continue; }
		try { await app.vault.process(file, (content) => { const changed = removeBrokenNoteLinks(content, selected); result.removed += changed.removed; result.skipped += changed.skipped; return changed.content; }); }
		catch (error) { result.failed.push({ path, reason: `${selected.length} 条链接：${error instanceof Error ? error.message : '未知错误'}` }); }
	}
	return result;
}

export interface CreateMissingNotesResult {
	created: string[];
	skipped: Array<{ path: string; reason: string }>;
	failed: Array<{ path: string; reason: string }>;
}

export async function createMissingNotes(app: App, links: BrokenNoteLink[]): Promise<CreateMissingNotesResult> {
	const result: CreateMissingNotesResult = { created: [], skipped: [], failed: [] };
	const targets = new Map<string, BrokenNoteLink[]>();
	for (const link of links) {
		const path = missingNotePath(link);
		if (!path) result.skipped.push({ path: link.linkPath, reason: '目标路径无效' });
		else (targets.get(path) ?? (targets.set(path, []), targets.get(path)!)).push(link);
	}
	for (const [path, targetLinks] of targets) {
		if (pathExistsCaseInsensitive(app, path)) {
			result.skipped.push({ path, reason: '目标已存在' });
			continue;
		}
		if (!(await Promise.all(targetLinks.map((link) => isCurrentMissingNoteLink(app, link)))).some(Boolean)) {
			result.skipped.push({ path, reason: '链接已变化或目标已恢复' });
			continue;
		}
		try {
			const parent = path.slice(0, path.lastIndexOf('/'));
			if (parent) {
				let current = '';
				for (const segment of parent.split('/')) {
					current = current ? `${current}/${segment}` : segment;
					if (!pathExistsCaseInsensitive(app, current)) await app.vault.createFolder(current);
				}
			}
			if (pathExistsCaseInsensitive(app, path)) {
				result.skipped.push({ path, reason: '目标已存在' });
				continue;
			}
			await app.vault.create(path, '');
			result.created.push(path);
		} catch (error) {
			result.failed.push({ path, reason: error instanceof Error ? error.message : '创建失败' });
		}
	}
	return result;
}

async function isCurrentMissingNoteLink(app: App, link: BrokenNoteLink) {
	if (app.metadataCache.getFirstLinkpathDest(link.linkPath, link.sourcePath)) return false;
	const source = app.vault.getFileByPath(link.sourcePath);
	if (!source || source.extension.toLowerCase() !== 'md') return false;
	return findBrokenNoteLinkOffset(await app.vault.read(source), link) !== null;
}

function pathExistsCaseInsensitive(app: App, path: string) {
	const normalized = path.toLowerCase();
	return app.vault.getAllLoadedFiles().some((file) => file.path.toLowerCase() === normalized);
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

function parseLink(original: string, raw: string) {
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
]);

function isExternal(path: string) { return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path); }
function parseExtensions(value: string) { return new Set(value.split(/[,，\s]+/).map((x) => x.replace(/^\./, '').toLowerCase()).filter(Boolean)); }
function isInsideIgnoredRange(cache: CachedMetadata, position: Pos) {
	const frontmatter = cache.frontmatterPosition;
	return (frontmatter && contains(frontmatter, position)) || (cache.sections ?? []).some((section) => section.type === 'code' && contains(section.position, position));
}
function contains(a: Pos, b: Pos) { return b.start.offset >= a.start.offset && b.end.offset <= a.end.offset; }
