import type { CachedMetadata, Pos } from 'obsidian';

export async function forEachWithConcurrency<T>(items: T[], concurrency: number, visit: (item: T, index: number) => Promise<void>): Promise<void> {
	const limit = Math.max(1, Math.min(concurrency, items.length || 1));
	let next = 0;
	let failure: unknown;
	let aborted = false;
	const workers = Array.from({ length: limit }, async () => {
		while (!aborted) {
			const index = next++;
			if (index >= items.length) return;
			try {
				await visit(items[index] as T, index);
			} catch (error) {
				// Stop handing out work, but let the visits already running settle so
				// no scan keeps touching the vault after the caller sees the rejection.
				if (!aborted) {
					aborted = true;
					failure = error;
				}
				return;
			}
		}
	});
	await Promise.all(workers);
	if (aborted) throw failure;
}

export function joinVaultPath(base: string, sub: string): string {
	return [base.replace(/^\/+|\/+$/g, ''), sub.replace(/^\/+|\/+$/g, '')]
		.filter(Boolean)
		.join('/');
}

export function groupingModeFromLegacy(raw: { groupBySource?: unknown; groupByPath?: unknown }): 'none' | 'source' | 'path' {
	return raw.groupBySource === true ? 'source' : raw.groupByPath === true ? 'path' : 'none';
}

export function isVaultRelativePath(path: string): boolean {
	const normalized = path.replace(/\\/g, '/');
	return !normalized.includes('\0')
		&& !normalized.startsWith('/')
		&& !normalized.includes(':')
		&& !normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

export function hasHiddenPathSegment(path: string): boolean {
	return path.split('/').some((segment) => segment.startsWith('.'));
}

const PLAIN_PATH_BASENAME_PATTERN = /^[\p{L}\p{N}_\-. /\\]+\.[a-z0-9]+$/iu;

// Matches sequences that look like "name.ext" or "folder/name with spaces.ext".
// Used for conservative textual reference detection: any mention counts.
// Runs of allowed characters are matched first so a long stretch without a file
// extension cannot trigger regex backtracking across the whole run.
const PATH_LIKE_RUN_PATTERN = /[\p{L}\p{N}_%\-. /\\]+/gu;

function isAsciiAlphanumeric(code: number) {
	return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

// Mirrors `[a-z0-9]+` (case insensitive) at the end of a run.
function extensionEndOf(run: string, start: number) {
	for (let index = run.length - 1; index > start; index--) {
		if (run.charCodeAt(index) !== 0x2e) continue;
		if (!isAsciiAlphanumeric(run.charCodeAt(index + 1))) continue;
		let end = index + 1;
		while (end < run.length && isAsciiAlphanumeric(run.charCodeAt(end))) end++;
		return end;
	}
	return -1;
}

export function pathLikeTokens(content: string): string[] {
	const tokens: string[] = [];
	for (const match of content.matchAll(PATH_LIKE_RUN_PATTERN)) {
		const run = match[0];
		let start = 0;
		while (start < run.length && run.charCodeAt(start) === 0x20) start++;
		if (start >= run.length) continue;
		const end = extensionEndOf(run, start);
		if (end < 0) continue;
		tokens.push(run.slice(start, end).toLowerCase());
	}
	return tokens;
}

// Greedy matching can merge prose prefixes into a token ("see note.png").
// Space-split suffixes recover the actual file name for conservative lookups.
export function pathTokenCandidates(token: string): string[] {
	const parts = token.split(' ');
	const candidates: string[] = [];
	for (let start = 0; start < parts.length; start++) {
		const candidate = parts.slice(start).join(' ');
		if (candidate) candidates.push(candidate);
	}
	return candidates;
}

// Basenames outside the token alphabet (e.g. containing parentheses) cannot be
// found by token matching and need a direct case-insensitive text search.
export function needsRawTextSearch(basename: string): boolean {
	return !PLAIN_PATH_BASENAME_PATTERN.test(basename.toLowerCase());
}

// Single source of truth for extension-list parsing: trim, drop a leading
// dot, lowercase, and keep only plain alphanumeric tokens. Malformed tokens
// such as `!exe` or `tar.gz` normalize to '' and can never match a real
// extension extracted from a path.
export function normalizeExtensionToken(value: string): string {
	const token = value.trim().replace(/^\./, '').toLowerCase();
	return /^[a-z0-9]+$/.test(token) ? token : '';
}

export function parseExtensions(value: string): Set<string> {
	return new Set(value.split(/[,，\s]+/).map(normalizeExtensionToken).filter(Boolean));
}

export function parseIgnoredFolders(value: string): string[] {
	return [...new Set(value.split(/[,，\s]+/).map((path) => path.trim().replace(/^\/+|\/+$/g, '').replace(/\\/g, '/')).filter(Boolean))];
}

export function platformFromUserAgent(userAgent: string): string {
	const text = userAgent.toLowerCase();
	if (text.includes('android')) return 'android';
	if (/iphone|ipad|ipod/.test(text)) return 'ios';
	if (text.includes('win')) return 'win32';
	if (text.includes('mac')) return 'darwin';
	if (text.includes('linux')) return 'linux';
	return '';
}

function detectPlatform(): string {
	if (typeof activeWindow === 'undefined') return '';
	const userAgent = activeWindow.navigator?.userAgent;
	return typeof userAgent === 'string' ? platformFromUserAgent(userAgent) : '';
}

// Obsidian filesystems: Windows/macOS/iOS are case-insensitive; Linux/Android
// are case-sensitive. Unknown platforms fall back to case-insensitive matching
// so Windows users see no change.
export function isCaseSensitivePlatform(platform: string | undefined): boolean {
	const value = (platform ?? '').toLowerCase();
	return value === 'linux' || value === 'android';
}

let autoCaseSensitive: boolean | null = null;

export function isCaseSensitiveFileSystem(platform?: string): boolean {
	if (platform !== undefined) return isCaseSensitivePlatform(platform);
	if (autoCaseSensitive === null) autoCaseSensitive = isCaseSensitivePlatform(detectPlatform());
	return autoCaseSensitive;
}

export function isIgnoredPath(path: string, ignoredFolders: string[], caseSensitive = isCaseSensitiveFileSystem()): boolean {
	const normalize = (value: string) => {
		const normalized = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
		return caseSensitive ? normalized : normalized.toLowerCase();
	};
	const normalized = normalize(path);
	return ignoredFolders.some((folder) => {
		const normalizedFolder = normalize(folder);
		return normalized === normalizedFolder || normalized.startsWith(`${normalizedFolder}/`);
	});
}

export function isPathInFolder(path: string, folderPath: string): boolean {
	return !folderPath || path.startsWith(`${folderPath.replace(/\/+$/, '')}/`);
}

export function isFrontmatterOnly(content: string): boolean {
	return /^\uFEFF?\s*---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?[ \t]*---[ \t]*(?:\r?\n)?\s*$/.test(content);
}

const EXTERNAL_LINK_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function isExternalLink(path: string): boolean {
	return EXTERNAL_LINK_PATTERN.test(path);
}

/**
 * Links inside frontmatter or code sections are metadata, not live links.
 * Shared by every cache-based link scan so they cannot drift apart.
 */
export function isInsideIgnoredRange(cache: CachedMetadata, position: Pos): boolean {
	const frontmatter = cache.frontmatterPosition;
	if (frontmatter && containsPosition(frontmatter, position)) return true;
	return (cache.sections ?? []).some((section) => section.type === 'code' && containsPosition(section.position, position));
}

function containsPosition(range: Pos, position: Pos): boolean {
	return position.start.offset >= range.start.offset && position.end.offset <= range.end.offset;
}

export function errorMessage(error: unknown, fallback = '未知错误'): string {
	return error instanceof Error ? error.message : fallback;
}

export function normalizeSettings<T extends object>(
	defaults: T,
	raw: unknown,
	validators: Partial<Record<keyof T, (value: unknown) => boolean>> = {},
): T {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...defaults };
	const persisted = raw as Record<string, unknown>;
	const result = { ...defaults };
	const defaultValues = defaults as Record<string, unknown>;
	for (const key of Object.keys(defaultValues)) {
		const validator = validators[key as keyof T];
		if (typeof persisted[key] === typeof defaultValues[key] && (!validator || validator(persisted[key]))) {
			(result as Record<string, unknown>)[key] = persisted[key];
		}
	}
	return result;
}

export interface CachedLinkRange {
	original: string;
	position: { start: { offset: number }; end: { offset: number } };
}

interface ContentLine {
	start: number;
	end: number;
}

const MAX_INDEXED_LINES = 200_000;

/**
 * Removes cached link ranges right to left. A range that becomes the only
 * content on its line takes the whole line with it, matching the original
 * one-link-at-a-time behaviour. Edits are kept per line so removing many links
 * no longer rewrites the whole document for every link.
 */
export function removeCachedLinkRanges(
	content: string,
	links: CachedLinkRange[],
	matches: (actual: string, original: string) => boolean,
): { content: string; removed: number; skipped: number } {
	if (links.length < 2) return removeCachedLinkRangesSequentially(content, links, matches);
	const resolveLine = createLineResolver(content);
	const edited = new Map<number, string>();
	const deleted = new Set<number>();
	let removed = 0;
	let skipped = 0;
	const sorted = [...links].sort((a, b) => b.position.start.offset - a.position.start.offset);
	for (const link of sorted) {
		const start = link.position.start.offset;
		const end = link.position.end.offset;
		if (start < 0 || end <= start || end > content.length) {
			skipped++;
			continue;
		}
		const line = resolveLine(start);
		if (start >= line.end || end > line.end) {
			// Offsets that spill onto a newline are not produced by Obsidian's
			// cache; keep the exact legacy result for such stale positions.
			return removeCachedLinkRangesSequentially(content, links, matches);
		}
		const key = line.start;
		if (deleted.has(key)) {
			skipped++;
			continue;
		}
		const text = edited.get(key) ?? content.slice(line.start, line.end);
		const localStart = start - line.start;
		const localEnd = end - line.start;
		if (localEnd > text.length || !matches(text.slice(localStart, localEnd), link.original)) {
			skipped++;
			continue;
		}
		if (text.slice(0, localStart).trim() === '' && text.slice(localEnd).trim() === '') {
			deleted.add(key);
			edited.delete(key);
			removed++;
			continue;
		}
		edited.set(key, text.slice(0, localStart) + text.slice(localEnd));
		removed++;
	}

	const changed = [...new Set([...edited.keys(), ...deleted.keys()])].sort((a, b) => a - b);
	const parts: string[] = [];
	let cursor = 0;
	for (const key of changed) {
		const line = resolveLine(key);
		parts.push(content.slice(cursor, line.start));
		if (!deleted.has(key)) parts.push(edited.get(key) ?? content.slice(line.start, line.end));
		cursor = line.end < content.length ? line.end + 1 : line.end;
	}
	parts.push(content.slice(cursor));
	return { content: parts.join(''), removed, skipped };
}

function removeCachedLinkRangesSequentially(
	content: string,
	links: CachedLinkRange[],
	matches: (actual: string, original: string) => boolean,
) {
	let result = content;
	let removed = 0;
	let skipped = 0;
	for (const link of [...links].sort((a, b) => b.position.start.offset - a.position.start.offset)) {
		const start = link.position.start.offset;
		const end = link.position.end.offset;
		if (start < 0 || end <= start || end > result.length || !matches(result.slice(start, end), link.original)) {
			skipped++;
			continue;
		}
		const lineStart = result.lastIndexOf('\n', start - 1) + 1;
		const newline = result.indexOf('\n', end);
		const lineEnd = newline < 0 ? result.length : newline;
		const onlyContentOnLine = result.slice(lineStart, start).trim() === '' && result.slice(end, lineEnd).trim() === '';
		result = onlyContentOnLine
			? result.slice(0, lineStart) + result.slice(lineEnd + (lineEnd < result.length ? 1 : 0))
			: result.slice(0, start) + result.slice(end);
		removed++;
	}
	return { content: result, removed, skipped };
}

function createLineResolver(content: string): (offset: number) => ContentLine {
	const lineStarts = [0];
	for (let newline = content.indexOf('\n'); newline >= 0; newline = content.indexOf('\n', newline + 1)) {
		lineStarts.push(newline + 1);
		if (lineStarts.length > MAX_INDEXED_LINES) return createScanningLineResolver(content);
	}
	return (offset) => {
		let low = 0;
		let high = lineStarts.length - 1;
		while (low < high) {
			const middle = (low + high + 1) >> 1;
			if (lineStarts[middle]! <= offset) low = middle;
			else high = middle - 1;
		}
		return {
			start: lineStarts[low]!,
			end: low + 1 < lineStarts.length ? lineStarts[low + 1]! - 1 : content.length,
		};
	};
}

function createScanningLineResolver(content: string): (offset: number) => ContentLine {
	const cache = new Map<number, ContentLine>();
	return (offset) => {
		const start = content.lastIndexOf('\n', offset - 1) + 1;
		let line = cache.get(start);
		if (!line) {
			const newline = content.indexOf('\n', start);
			line = { start, end: newline < 0 ? content.length : newline };
			cache.set(start, line);
		}
		return line;
	};
}
