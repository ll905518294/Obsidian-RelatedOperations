import type { CachedMetadata, Pos } from 'obsidian';
import { isCaseSensitiveFileSystem } from '../core-utils.ts';

export type ImageReferenceSourceKind = 'markdown' | 'canvas';

export type ImageReferenceBlockReason =
	| 'ambiguous-basename'
	| 'canvas-text-embed'
	| 'code-block-reference'
	| 'count-mismatch'
	| 'css-url'
	| 'frontmatter-plain-path'
	| 'has-size'
	| 'html-img'
	| 'html-source'
	| 'srcset'
	| 'unsupported-source';

export interface ImageReferenceSourceFile {
	path: string;
	extension: string;
}

export interface ImageReferenceApp {
	vault: {
		getFiles(): ImageReferenceSourceFile[];
		getFileByPath?(path: string): ImageReferenceSourceFile | null;
		cachedRead(file: ImageReferenceSourceFile): Promise<string>;
		read?(file: ImageReferenceSourceFile): Promise<string>;
	};
	metadataCache: {
		resolvedLinks: Record<string, Record<string, number>>;
		getFileCache(file: ImageReferenceSourceFile): CachedMetadata | null;
		getFirstLinkpathDest(link: string, sourcePath: string): { path: string } | null;
	};
}

export interface ImageReferenceSite {
	sourcePath: string;
	sourceKind: ImageReferenceSourceKind;
	liveRefs: number;
	textMentions: number;
}

export type ImageReferenceScanResult =
	| {
		ok: true;
		sites: ImageReferenceSite[];
		totalLiveRefs: number;
		totalTextMentions: number;
	}
	| {
		ok: false;
		reason: ImageReferenceBlockReason;
		reasonText: string;
		sourcePath?: string;
	};

export interface ImageReferenceContext {
	sourcePath: string;
	sourceKind?: ImageReferenceSourceKind;
	caseSensitive?: boolean;
	resolveLink?: (linkPath: string) => string | null;
	vaultPaths?: string[];
}

export interface ImageContentAnalysis {
	liveRefs: number;
	textMentions: number;
	htmlRefs: number;
	hasSize: boolean;
	hasSrcset: boolean;
	hasFrontmatterPlainPath: boolean;
	hasCanvasTextEmbed: boolean;
	hasAmbiguousNoExtension: boolean;
	hasUnsupportedHtml: boolean;
	hasHtmlSource: boolean;
	hasCssUrl: boolean;
	hasCodeBlockReference: boolean;
	error?: string;
}

export interface ImageReferenceRewriteResult {
	content: string;
	rewritten: number;
	blockedReason?: ImageReferenceBlockReason;
	reasonText?: string;
	error?: string;
}

interface Range {
	start: number;
	end: number;
}

type PathStyle = 'absolute' | 'basename' | 'relative' | 'vault';
type RewriteKind = 'canvas' | 'markdown';

interface WikiSpanInfo {
	alias: string;
	bang: boolean;
	originalTarget: string;
}

interface ReferenceSpan extends Range {
	allowBareName: boolean;
	kind: 'html' | 'markdown' | 'wiki-body' | 'wiki-frontmatter';
	rawTarget: string;
	wiki?: WikiSpanInfo;
}

interface CollectedAnalysis {
	analysis: ImageContentAnalysis;
	spans: ReferenceSpan[];
}

interface CanvasAnalysis extends CollectedAnalysis {
	data?: Record<string, unknown>;
}

const EXTERNAL_LINK_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const WIKI_PATTERN = /(!?)\[\[([^\]\n]+)\]\]/g;
const MARKDOWN_LINK_PATTERN = /!?\[[^\x5D\n]*\]\(\s*(<[^>\n]*>|(?:[^()\s]|\([^()\n]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const HTML_IMG_PATTERN = /<img\b[^>]*>/gi;
const HTML_SOURCE_PATTERN = /<source\b[^>]*>/gi;
const HTML_TAG_PATTERN = /<[a-z][^>]*>/gi;
const HTML_SRCSET_PATTERN = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const CSS_URL_PATTERN = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
const FRONTMATTER_VALUE_PATTERN = /(^|[\s:[{,-])(?:"([^"\n]*)"|'([^'\n]*)'|([^\s,\x5B\x5D{}#]+))/g;

export async function findImageReferences(
	app: ImageReferenceApp,
	sourcePath: string,
	caseSensitive = isCaseSensitiveFileSystem(),
): Promise<ImageReferenceScanResult> {
	const files = app.vault.getFiles();
	if (!files.some((file) => file.path === sourcePath)) {
		return { ok: false, reason: 'unsupported-source', reasonText: '图片文件不存在' };
	}
	const allPaths = files.map((file) => file.path);
	const sites: ImageReferenceSite[] = [];
	let totalLiveRefs = 0;
	let totalTextMentions = 0;
	for (const file of files) {
		const kind = sourceKind(file.path);
		if (!kind) continue;
		const expected = resolvedReferenceCount(
			app.metadataCache.resolvedLinks?.[file.path],
			sourcePath,
			caseSensitive,
		);
		const content = await readText(app, file);
		const resolver = (link: string) => app.metadataCache.getFirstLinkpathDest(link, file.path)?.path ?? null;
		const collected = kind === 'canvas'
			? collectCanvasAnalysis(content, sourcePath, file.path, resolver, allPaths, caseSensitive)
			: collectMarkdownAnalysis(content, sourcePath, file.path, resolver, allPaths, caseSensitive);
		if (collected.analysis.error) {
			return { ok: false, reason: 'unsupported-source', reasonText: collected.analysis.error, sourcePath: file.path };
		}
		const blocked = blockedReasonFor(collected.analysis);
		if (blocked) return { ok: false, ...blocked, sourcePath: file.path };

		let liveRefs = collected.analysis.liveRefs;
		if (kind === 'markdown' && (liveRefs > 0 || expected > 0)) {
			const cached = countCachedMarkdownReferences(app, file, sourcePath, content, caseSensitive);
			if (cached === null) {
				return { ok: false, reason: 'count-mismatch', reasonText: `${file.path} 的元数据尚未就绪`, sourcePath: file.path };
			}
			const expectedLiveRefs = cached + collected.analysis.htmlRefs;
			if (expectedLiveRefs !== liveRefs) {
				return {
					ok: false,
					reason: 'count-mismatch',
					reasonText: `${file.path} 的缓存与文本引用数量不一致（缓存 ${expectedLiveRefs}，文本 ${liveRefs}）`,
					sourcePath: file.path,
				};
			}
			liveRefs = expectedLiveRefs;
		}
		// Obsidian 不保证 Canvas 的引用进入 resolvedLinks；Canvas 始终以文本
		// 枚举为准，只有索引明确记录了该图片时才要求两者一致。
		if ((kind === 'markdown' || expected > 0) && liveRefs !== expected) {
			return {
				ok: false,
				reason: 'count-mismatch',
				reasonText: `${file.path} 的引用数量与索引不一致（索引 ${expected}，定位 ${liveRefs}）`,
				sourcePath: file.path,
			};
		}
		if (liveRefs > 0) {
			sites.push({ sourcePath: file.path, sourceKind: kind, liveRefs, textMentions: collected.analysis.textMentions });
			totalLiveRefs += liveRefs;
			totalTextMentions += collected.analysis.textMentions;
		}
	}
	return { ok: true, sites, totalLiveRefs, totalTextMentions };
}

function resolvedReferenceCount(
	record: Record<string, number> | undefined,
	targetPath: string,
	caseSensitive: boolean,
): number {
	if (!record) return 0;
	let count = 0;
	for (const [path, value] of Object.entries(record)) {
		if (typeof value !== 'number' || value <= 0) continue;
		if (samePath(path, targetPath, caseSensitive)) count += value;
	}
	return count;
}

export async function countLiveReferencesInVault(app: ImageReferenceApp, targetPath: string): Promise<number> {
	const caseSensitive = isCaseSensitiveFileSystem();
	const files = app.vault.getFiles();
	const allPaths = files.map((file) => file.path);
	let total = 0;
	for (const file of files) {
		const kind = sourceKind(file.path);
		if (!kind) continue;
		const content = await readText(app, file);
		const resolver = (link: string) => app.metadataCache.getFirstLinkpathDest(link, file.path)?.path ?? null;
		const collected = kind === 'canvas'
			? collectCanvasAnalysis(content, targetPath, file.path, resolver, allPaths, caseSensitive)
			: collectMarkdownAnalysis(content, targetPath, file.path, resolver, allPaths, caseSensitive);
		total += collected.analysis.liveRefs;
	}
	return total;
}

export function hasRawImageReference(
	content: string,
	oldPath: string,
	caseSensitive = isCaseSensitiveFileSystem(),
): boolean {
	const normalized = content.replace(/\r\n?/g, '\n');
	const haystack = caseSensitive ? normalized : normalized.toLowerCase();
	return rawReferenceVariants(oldPath, caseSensitive).some((variant) => haystack.includes(variant));
}

export async function findRawImageReferenceSources(
	app: ImageReferenceApp,
	targetPath: string,
	caseSensitive = isCaseSensitiveFileSystem(),
): Promise<string[]> {
	const sources: string[] = [];
	for (const file of app.vault.getFiles()) {
		if (!sourceKind(file.path)) continue;
		const content = await readText(app, file);
		if (hasRawImageReference(content, targetPath, caseSensitive)) sources.push(file.path);
	}
	return sources;
}

export function analyzeReferenceContent(
	content: string,
	oldPath: string,
	sourcePath: string,
	sourceKind: ImageReferenceSourceKind,
	resolveLink?: (linkPath: string) => string | null,
	vaultPaths?: string[],
	caseSensitive = isCaseSensitiveFileSystem(),
): ImageContentAnalysis {
	return (sourceKind === 'canvas'
		? collectCanvasAnalysis(content, oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive)
		: collectMarkdownAnalysis(content, oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive)).analysis;
}

export function rewriteImageReferences(
	content: string,
	oldPath: string,
	newPath: string,
	sourceKind: ImageReferenceSourceKind,
	context?: ImageReferenceContext,
): ImageReferenceRewriteResult {
	const sourcePath = context?.sourcePath ?? '';
	const resolveLink = context?.resolveLink;
	const vaultPaths = context?.vaultPaths;
	const caseSensitive = context?.caseSensitive ?? isCaseSensitiveFileSystem();
	if (sourceKind === 'canvas') {
		return rewriteCanvasReferences(content, oldPath, newPath, sourcePath, caseSensitive, resolveLink, vaultPaths);
	}
	const collected = collectMarkdownAnalysis(content, oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive);
	if (collected.analysis.error) return { content, rewritten: 0, error: collected.analysis.error };
	const blocked = blockedReasonFor(collected.analysis);
	if (blocked) return { content, rewritten: 0, blockedReason: blocked.reason, reasonText: blocked.reasonText };
	const matcher = createMatcher(oldPath, newPath, sourcePath, caseSensitive, resolveLink, vaultPaths, 'markdown');
	let rewritten = 0;
	let result = '';
	let cursor = 0;
	for (const span of collected.spans) {
		if (span.start < cursor) continue;
		const replacement = span.kind === 'wiki-body'
			? wikiBodyReplacement(span, newPath, sourcePath)
			: matcher.render(span.rawTarget, span.allowBareName);
		if (replacement === null) continue;
		result += content.slice(cursor, span.start) + replacement;
		cursor = span.end;
		rewritten++;
	}
	result += content.slice(cursor);
	return { content: result, rewritten };
}

export function countRemainingReferences(
	content: string,
	oldPath: string,
	context?: Partial<ImageReferenceContext>,
): number {
	return analyzeReferenceContent(
		content,
		oldPath,
		context?.sourcePath ?? '',
		context?.sourceKind ?? 'markdown',
		context?.resolveLink,
		context?.vaultPaths,
		context?.caseSensitive,
	).liveRefs;
}

function collectMarkdownAnalysis(
	content: string,
	oldPath: string,
	sourcePath: string,
	resolveLink: ((linkPath: string) => string | null) | undefined,
	vaultPaths: string[] | undefined,
	caseSensitive: boolean,
): CollectedAnalysis {
	const code = codeRanges(content);
	const htmlTags = htmlTagRanges(content, code);
	const frontmatter = frontmatterRange(content);
	const occupied: Range[] = [];
	const spans: ReferenceSpan[] = [];
	const noExtensionRefs: string[] = [];
	const analysis: ImageContentAnalysis = {
		liveRefs: 0,
		textMentions: 0,
		htmlRefs: 0,
		hasSize: false,
		hasSrcset: false,
		hasFrontmatterPlainPath: false,
		hasCanvasTextEmbed: false,
		hasAmbiguousNoExtension: false,
		hasUnsupportedHtml: false,
		hasHtmlSource: false,
		hasCssUrl: false,
		hasCodeBlockReference: false,
	};

	for (const match of content.matchAll(CSS_URL_PATTERN)) {
		const start = match.index ?? 0;
		if (insideRanges(start, code)) continue;
		const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
		if (value && resolvePathStyle(value, oldPath, sourcePath, false, resolveLink, vaultPaths, caseSensitive)) {
			analysis.hasCssUrl = true;
		}
	}
	for (const match of content.matchAll(HTML_SOURCE_PATTERN)) {
		const start = match.index ?? 0;
		if (insideRanges(start, code)) continue;
		const tag = match[0];
		const src = attributeRange(tag, 'src');
		const srcset = attributeRange(tag, 'srcset');
		if ((src && resolvePathStyle(src.value, oldPath, sourcePath, false, resolveLink, vaultPaths, caseSensitive))
			|| (srcset && srcsetMentions(srcset.value, oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive))) {
			analysis.hasHtmlSource = true;
		}
	}
	if (sourcePath.toLowerCase().endsWith('.excalidraw.md')) {
		analysis.hasCodeBlockReference = code.some((range) =>
			hasRawImageReference(content.slice(range.start, range.end), oldPath, caseSensitive));
	}

	for (const match of content.matchAll(WIKI_PATTERN)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (insideRanges(start, code) || insideRanges(start, htmlTags)) continue;
		const bang = match[1] === '!';
		const innerStart = start + (bang ? 3 : 2);
		const inner = content.slice(innerStart, end - 2);
		const pipe = inner.indexOf('|');
		const targetRaw = pipe >= 0 ? inner.slice(0, pipe) : inner;
		const leading = targetRaw.length - targetRaw.trimStart().length;
		const trailing = targetRaw.length - targetRaw.trimEnd().length;
		const targetStart = innerStart + leading;
		const targetEnd = innerStart + targetRaw.length - trailing;
		const target = content.slice(targetStart, targetEnd);
		if (!target) continue;
		const params = pipe >= 0 ? inner.slice(pipe + 1).split('|').map((part) => part.trim()) : [];
		const size = params.some(isSizePart);
		const inFrontmatter = !!frontmatter && targetStart >= frontmatter.start && targetEnd <= frontmatter.end;
		const resolved = resolvePathStyle(target, oldPath, sourcePath, true, resolveLink, vaultPaths, caseSensitive);
		if (!resolved) continue;
		analysis.liveRefs++;
		if (size) analysis.hasSize = true;
		if (extensionOf(target) === '' && !target.includes('/')) noExtensionRefs.push(target);
		spans.push({
			start: inFrontmatter ? targetStart : start,
			end: inFrontmatter ? targetEnd : end,
			kind: inFrontmatter ? 'wiki-frontmatter' : 'wiki-body',
			rawTarget: target,
			allowBareName: true,
			wiki: {
				alias: params.find((part) => !isSizePart(part)) ?? '',
				bang,
				originalTarget: target,
			},
		});
		occupied.push({ start, end });
	}

	for (const match of content.matchAll(MARKDOWN_LINK_PATTERN)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (insideRanges(start, code) || insideRanges(start, htmlTags) || overlaps(start, end, occupied)) continue;
		const targetRaw = match[1];
		if (!targetRaw) continue;
		const targetStart = start + markdownTargetOffset(match[0]);
		const targetEnd = targetStart + targetRaw.length;
		if (targetStart < start || targetEnd > end) continue;
		const resolved = resolvePathStyle(targetRaw, oldPath, sourcePath, false, resolveLink, vaultPaths, caseSensitive);
		if (!resolved) continue;
		analysis.liveRefs++;
		spans.push({ start: targetStart, end: targetEnd, kind: 'markdown', rawTarget: targetRaw, allowBareName: false });
		occupied.push({ start, end });
	}

	for (const match of content.matchAll(HTML_SRCSET_PATTERN)) {
		const start = match.index ?? 0;
		if (insideRanges(start, code)) continue;
		const value = match[1] ?? match[2] ?? match[3] ?? '';
		if (srcsetMentions(value, oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive)) analysis.hasSrcset = true;
	}
	for (const match of content.matchAll(HTML_IMG_PATTERN)) {
		const tagStart = match.index ?? 0;
		const tag = match[0];
		if (insideRanges(tagStart, code) || overlaps(tagStart, tagStart + tag.length, occupied)) continue;
		const src = attributeRange(tag, 'src');
		const srcset = attributeRange(tag, 'srcset');
		if (srcset && (srcsetMentions(srcset.value, oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive)
			|| (src && resolvePathStyle(src.value, oldPath, sourcePath, false, resolveLink, vaultPaths, caseSensitive)))) {
			analysis.hasSrcset = true;
		}
		if (!src) {
			if (tag.includes(basename(oldPath))) analysis.hasUnsupportedHtml = true;
			continue;
		}
		const resolved = resolvePathStyle(src.value, oldPath, sourcePath, false, resolveLink, vaultPaths, caseSensitive);
		if (!resolved) continue;
		const targetStart = tagStart + src.valueStart;
		const targetEnd = tagStart + src.valueEnd;
		analysis.liveRefs++;
		analysis.htmlRefs++;
		spans.push({ start: targetStart, end: targetEnd, kind: 'html', rawTarget: src.value, allowBareName: false });
		occupied.push({ start: tagStart, end: tagStart + tag.length });
	}

	if (frontmatter) {
		const body = content.slice(frontmatter.start, frontmatter.end);
		for (const match of body.matchAll(FRONTMATTER_VALUE_PATTERN)) {
			const token = match[2] ?? match[3] ?? match[4] ?? '';
			if (!token || token.endsWith(':') || token.includes(':') || token.includes('[[') || token.startsWith('#')) continue;
			const tokenStart = frontmatter.start + (match.index ?? 0) + match[0].length - token.length - (match[2] !== undefined || match[3] !== undefined ? 1 : 0);
			const tokenEnd = tokenStart + token.length;
			if (insideRanges(tokenStart, code) || insideRanges(tokenStart, htmlTags) || overlaps(tokenStart, tokenEnd, occupied)) continue;
			if (resolvePathStyle(token, oldPath, sourcePath, true, resolveLink, vaultPaths, caseSensitive)) {
				analysis.hasFrontmatterPlainPath = true;
				analysis.liveRefs++;
			}
		}
	}

	for (const range of code) {
		analysis.textMentions += countMentionsInRange(content.slice(range.start, range.end), oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive);
	}
	if (vaultPaths && noExtensionRefs.length) {
		analysis.hasAmbiguousNoExtension = noExtensionRefs.some((target) => {
			const stem = target.trim().toLowerCase();
			if (stem.includes('/')) return false;
			return vaultPaths.filter((path) => stripExtension(basename(path)).toLowerCase() === stem).length > 1;
		});
	}
	return { analysis, spans: dedupeSpans(spans) };
}

function collectCanvasAnalysis(
	content: string,
	oldPath: string,
	sourcePath: string,
	resolveLink: ((linkPath: string) => string | null) | undefined,
	vaultPaths: string[] | undefined,
	caseSensitive: boolean,
): CanvasAnalysis {
	const analysis: ImageContentAnalysis = {
		liveRefs: 0,
		textMentions: 0,
		htmlRefs: 0,
		hasSize: false,
		hasSrcset: false,
		hasFrontmatterPlainPath: false,
		hasCanvasTextEmbed: false,
		hasAmbiguousNoExtension: false,
		hasUnsupportedHtml: false,
		hasHtmlSource: false,
		hasCssUrl: false,
		hasCodeBlockReference: false,
	};
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(content) as Record<string, unknown>;
	} catch (error) {
		return { analysis: { ...analysis, error: `Canvas JSON 解析失败：${reasonOf(error)}` }, spans: [] };
	}
	const nodes = Array.isArray(data.nodes) ? data.nodes : [];
	for (const node of nodes) {
		if (!node || typeof node !== 'object') continue;
		const record = node as Record<string, unknown>;
		if (typeof record.file === 'string'
			&& resolvePathStyle(record.file, oldPath, sourcePath, false, resolveLink, vaultPaths, caseSensitive)) {
			analysis.liveRefs++;
		}
		if (record.type === 'text' && typeof record.text === 'string') {
			const nested = collectMarkdownAnalysis(record.text, oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive);
			if (nested.analysis.liveRefs > 0 || nested.analysis.hasSize || nested.analysis.hasSrcset
				|| nested.analysis.hasFrontmatterPlainPath || nested.analysis.hasUnsupportedHtml) {
				analysis.hasCanvasTextEmbed = true;
			}
			analysis.textMentions += nested.analysis.textMentions;
		}
	}
	return { analysis, spans: [], data };
}

function rewriteCanvasReferences(
	content: string,
	oldPath: string,
	newPath: string,
	sourcePath: string,
	caseSensitive: boolean,
	resolveLink: ((linkPath: string) => string | null) | undefined,
	vaultPaths: string[] | undefined,
): ImageReferenceRewriteResult {
	const collected = collectCanvasAnalysis(content, oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive);
	if (collected.analysis.error) return { content, rewritten: 0, error: collected.analysis.error };
	const blocked = blockedReasonFor(collected.analysis);
	if (blocked) return { content, rewritten: 0, blockedReason: blocked.reason, reasonText: blocked.reasonText };
	const data = collected.data;
	if (!data) return { content, rewritten: 0 };
	const matcher = createMatcher(oldPath, newPath, sourcePath, caseSensitive, resolveLink, vaultPaths, 'canvas');
	let rewritten = 0;
	const nodes = Array.isArray(data.nodes) ? data.nodes : [];
	for (const node of nodes) {
		if (!node || typeof node !== 'object') continue;
		const record = node as Record<string, unknown>;
		if (typeof record.file !== 'string') continue;
		const replacement = matcher.render(record.file, false);
		if (replacement === null) continue;
		record.file = replacement;
		rewritten++;
	}
	if (rewritten === 0) return { content, rewritten: 0 };
	const trailingNewline = content.endsWith('\n') ? '\n' : '';
	const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
	return { content: `${bom}${JSON.stringify(data, null, '\t')}${trailingNewline}`, rewritten };
}

function createMatcher(
	oldPath: string,
	newPath: string,
	sourcePath: string,
	caseSensitive: boolean,
	resolveLink: ((linkPath: string) => string | null) | undefined,
	vaultPaths: string[] | undefined,
	kind: RewriteKind,
) {
	return {
		render(rawTarget: string, allowBareName: boolean): string | null {
			const parsed = parseRawTarget(rawTarget);
			if (!parsed) return null;
			const style = resolvePathStyle(parsed.path, oldPath, sourcePath, allowBareName, resolveLink, vaultPaths, caseSensitive);
			if (!style) return null;
			let rendered = kind === 'canvas'
				? newPath.replace(/\\/g, '/')
				: relativePath(dirname(sourcePath), newPath);
			if (/%[0-9a-f]{2}/i.test(parsed.path)) {
				const escapes = [...parsed.path.matchAll(/%([0-9a-f]{2})/gi)].map((match) => match[1]!.toLowerCase());
				rendered = escapes.some((escape) => escape !== '20')
					? encodeURI(rendered)
					: rendered.replace(/ /g, '%20');
			}
			rendered += parsed.suffix;
			return parsed.bracketed ? `<${rendered}>` : rendered;
		},
	};
}

function resolvePathStyle(
	rawTarget: string,
	oldPath: string,
	sourcePath: string,
	allowBareName: boolean,
	resolveLink: ((linkPath: string) => string | null) | undefined,
	_vaultPaths: string[] | undefined,
	caseSensitive: boolean,
): PathStyle | null {
	const parsed = parseRawTarget(rawTarget);
	if (!parsed) return null;
	const decoded = safeDecode(parsed.path).replace(/\\/g, '/');
	if (!decoded || EXTERNAL_LINK_PATTERN.test(decoded)) return null;
	const leadingSlash = decoded.startsWith('/');
	const bare = !decoded.includes('/');
	const vaultPath = decoded.replace(/^\/+/, '');

	if (resolveLink) {
		let resolvedAny = false;
		for (const candidate of [parsed.path, decoded]) {
			try {
				const resolved = resolveLink(candidate);
				if (!resolved) continue;
				resolvedAny = true;
				if (samePath(resolved, oldPath, caseSensitive)) {
					if (leadingSlash) return 'absolute';
					if (/^\.{1,2}\//.test(decoded)) return 'relative';
					if (bare && allowBareName) return 'basename';
					if (samePath(vaultPath, oldPath, caseSensitive)) return 'vault';
					return sourcePath ? 'relative' : 'vault';
				}
			} catch {
				// A resolver that throws is treated as unresolved; the textual
				// fallback below still handles unambiguous vault paths.
			}
		}
		// Obsidian's resolver is authoritative when it knows the link. Falling
		// back to a basename match here would rewrite a same-named file in a
		// different folder.
		if (resolvedAny) return null;
	}
	if (samePath(vaultPath, oldPath, caseSensitive)) return leadingSlash ? 'absolute' : 'vault';
	if (sourcePath && samePath(resolveRelative(sourcePath, decoded), oldPath, caseSensitive)) return 'relative';
	const oldStem = stripExtension(oldPath);
	if (extensionOf(decoded) === '') {
		if (samePath(vaultPath, oldStem, caseSensitive)) return leadingSlash ? 'absolute' : 'vault';
		if (sourcePath && samePath(resolveRelative(sourcePath, decoded), oldStem, caseSensitive)) return 'relative';
	}
	if (allowBareName && bare && basenameMatches(decoded, oldPath, caseSensitive)) return 'basename';
	return null;
}

function wikiBodyReplacement(span: ReferenceSpan, newPath: string, sourcePath: string): string {
	const suffix = splitSubpath(span.rawTarget).suffix;
	const destination = `<${relativePath(dirname(sourcePath), newPath)}${suffix}>`;
	const wiki = span.wiki;
	if (!wiki) return destination;
	const text = wiki.bang ? wiki.alias : (wiki.alias || wiki.originalTarget);
	return `${wiki.bang ? '!' : ''}[${text}](${destination})`;
}

function countCachedMarkdownReferences(
	app: ImageReferenceApp,
	file: ImageReferenceSourceFile,
	targetPath: string,
	content: string,
	caseSensitive: boolean,
): number | null {
	const cache = app.metadataCache.getFileCache(file);
	if (!cache) return null;
	const frontmatter = frontmatterRange(content);
	const entries: Array<{ key: string; link: string; original: string; inFrontmatter: boolean }> = [];
	for (const entry of cache.embeds ?? []) {
		entries.push({ key: positionKey(entry.position), link: entry.link, original: entry.original, inFrontmatter: inFrontmatterRange(entry.position, frontmatter) });
	}
	for (const entry of cache.links ?? []) {
		entries.push({ key: positionKey(entry.position), link: entry.link, original: entry.original, inFrontmatter: inFrontmatterRange(entry.position, frontmatter) });
	}
	const bodyFrontmatterLinks = new Set(entries
		.filter((entry) => entry.inFrontmatter)
		.map((entry) => entry.link));
	for (const entry of cache.frontmatterLinks ?? []) {
		if (bodyFrontmatterLinks.has(entry.link)) continue;
		entries.push({ key: `fm:${entry.key}:${entry.original}:${entry.link}`, link: entry.link, original: entry.original, inFrontmatter: true });
	}
	const seen = new Set<string>();
	let count = 0;
	for (const entry of entries) {
		if (seen.has(entry.key)) continue;
		seen.add(entry.key);
		if (linkResolvesTo(entry.link, file.path, targetPath, app, caseSensitive)) count++;
	}
	return count;
}

function inFrontmatterRange(position: Pos | undefined, frontmatter: Range | null): boolean {
	return !!position && !!frontmatter
		&& position.start.offset >= frontmatter.start
		&& position.end.offset <= frontmatter.end;
}

function linkResolvesTo(
	link: string,
	sourcePath: string,
	targetPath: string,
	app: ImageReferenceApp,
	caseSensitive: boolean,
): boolean {
	const clean = (link.split('#', 1)[0] ?? '').trim();
	if (!clean) return false;
	for (const candidate of [clean, safeDecode(clean)]) {
		const resolved = app.metadataCache.getFirstLinkpathDest(candidate, sourcePath);
		if (resolved && samePath(resolved.path, targetPath, caseSensitive)) return true;
		if (samePath(resolvedPathWithoutLeadingSlash(candidate), targetPath, caseSensitive)) return true;
	}
	return false;
}

function blockedReasonFor(analysis: ImageContentAnalysis): { reason: ImageReferenceBlockReason; reasonText: string } | null {
	if (analysis.hasSize) return { reason: 'has-size', reasonText: '图片引用包含尺寸参数，已整张跳过' };
	if (analysis.hasSrcset) return { reason: 'srcset', reasonText: '图片引用包含 srcset，无法安全改写' };
	if (analysis.hasHtmlSource) return { reason: 'html-source', reasonText: '图片引用包含 picture/source，无法安全改写' };
	if (analysis.hasCssUrl) return { reason: 'css-url', reasonText: '图片引用出现在 CSS url() 中，无法安全改写' };
	if (analysis.hasCodeBlockReference) return { reason: 'code-block-reference', reasonText: 'Excalidraw 代码块中包含图片引用，无法安全改写' };
	if (analysis.hasCanvasTextEmbed) return { reason: 'canvas-text-embed', reasonText: 'Canvas 文本节点包含图片引用，无法安全改写' };
	if (analysis.hasFrontmatterPlainPath) return { reason: 'frontmatter-plain-path', reasonText: 'Frontmatter 使用裸路径引用图片，无法安全改写' };
	if (analysis.hasUnsupportedHtml) return { reason: 'html-img', reasonText: '无法解析 HTML img 引用' };
	if (analysis.hasAmbiguousNoExtension) return { reason: 'ambiguous-basename', reasonText: '无扩展名引用存在同名文件，无法确定目标' };
	return null;
}

function countMentionsInRange(
	text: string,
	oldPath: string,
	sourcePath: string,
	resolveLink: ((linkPath: string) => string | null) | undefined,
	vaultPaths: string[] | undefined,
	caseSensitive: boolean,
): number {
	let count = 0;
	const seen: Range[] = [];
	for (const match of text.matchAll(WIKI_PATTERN)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		const target = wikiTarget(match);
		if (target && resolvePathStyle(target, oldPath, sourcePath, true, resolveLink, vaultPaths, caseSensitive)) {
			count++;
			seen.push({ start, end });
		}
	}
	for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (overlaps(start, end, seen)) continue;
		const target = match[1];
		if (target && resolvePathStyle(target, oldPath, sourcePath, false, resolveLink, vaultPaths, caseSensitive)) {
			count++;
			seen.push({ start, end });
		}
	}
	for (const match of text.matchAll(/[^\s`"'<>\x5B\x5D()]+/g)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (overlaps(start, end, seen)) continue;
		if (resolvePathStyle(match[0], oldPath, sourcePath, true, resolveLink, vaultPaths, caseSensitive)) count++;
	}
	return count;
}

function attributeRange(tag: string, name: string): { value: string; valueStart: number; valueEnd: number } | null {
	const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`, 'i');
	const match = pattern.exec(tag);
	if (!match) return null;
	const value = match[1] ?? match[2] ?? match[3] ?? '';
	const quote = match[1] !== undefined || match[2] !== undefined ? 1 : 0;
	const tokenStart = (match.index ?? 0) + match[0].length - value.length - quote;
	return { value, valueStart: tokenStart, valueEnd: tokenStart + value.length };
}

function srcsetMentions(
	value: string,
	oldPath: string,
	sourcePath: string,
	resolveLink: ((linkPath: string) => string | null) | undefined,
	vaultPaths: string[] | undefined,
	caseSensitive: boolean,
): boolean {
	return value.split(',').some((candidate) => {
		const path = candidate.trim().split(/\s+/, 1)[0] ?? '';
		return !!path && !!resolvePathStyle(path, oldPath, sourcePath, false, resolveLink, vaultPaths, caseSensitive);
	});
}

function codeRanges(content: string): Range[] {
	const ranges: Range[] = [];
	let offset = 0;
	let fence: { character: string; length: number; start: number } | null = null;
	while (offset < content.length) {
		const newline = content.indexOf('\n', offset);
		const lineEnd = newline < 0 ? content.length : newline;
		const next = newline < 0 ? content.length : newline + 1;
		const line = content.slice(offset, lineEnd);
		if (!fence) {
			const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
			if (match) fence = { character: match[1]![0]!, length: match[1]!.length, start: offset };
		} else {
			const match = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
			if (match && match[1]![0] === fence.character && match[1]!.length >= fence.length) {
				ranges.push({ start: fence.start, end: next });
				fence = null;
			}
		}
		offset = next;
	}
	if (fence) ranges.push({ start: fence.start, end: content.length });
	for (const match of content.matchAll(/(`+)([^`\n]*?)\1/g)) {
		const start = match.index ?? 0;
		if (insideRanges(start, ranges)) continue;
		ranges.push({ start, end: start + match[0].length });
	}
	ranges.sort((left, right) => left.start - right.start);
	return mergeRanges(ranges);
}

function htmlTagRanges(content: string, code: Range[]): Range[] {
	const ranges: Range[] = [];
	for (const match of content.matchAll(HTML_TAG_PATTERN)) {
		const start = match.index ?? 0;
		if (insideRanges(start, code)) continue;
		ranges.push({ start, end: start + match[0].length });
	}
	return ranges;
}

function frontmatterRange(content: string): Range | null {
	const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
	if (!match || !match[1]) return null;
	const start = (match.index ?? 0) + match[0].indexOf(match[1]);
	return { start, end: start + match[1].length };
}

function parseRawTarget(rawTarget: string): { bracketed: boolean; path: string; suffix: string } | null {
	let value = rawTarget.trim();
	if (!value) return null;
	let bracketed = false;
	if (value.startsWith('<') && value.endsWith('>')) {
		bracketed = true;
		value = value.slice(1, -1).trim();
	}
	const { path, suffix } = splitSubpath(value);
	if (!path) return null;
	return { bracketed, path, suffix };
}

function splitSubpath(value: string): { path: string; suffix: string } {
	const hash = value.indexOf('#');
	const query = value.indexOf('?');
	const indexes = [hash, query].filter((index) => index >= 0).sort((left, right) => left - right);
	const index = indexes[0];
	return index === undefined ? { path: value, suffix: '' } : { path: value.slice(0, index), suffix: value.slice(index) };
}

function wikiTarget(match: RegExpMatchArray): string {
	const inner = match[2] ?? '';
	const pipe = inner.indexOf('|');
	return (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
}

function markdownTargetOffset(match: string): number {
	const closeBracket = match.indexOf('](');
	let index = closeBracket >= 0 ? closeBracket + 2 : 0;
	while (index < match.length && /\s/.test(match[index]!)) index++;
	return index;
}

function dedupeSpans(spans: ReferenceSpan[]): ReferenceSpan[] {
	const sorted = [...spans].sort((left, right) => left.start - right.start || right.end - left.end);
	const accepted: ReferenceSpan[] = [];
	for (const span of sorted) {
		const previous = accepted.at(-1);
		if (previous && span.start < previous.end) continue;
		accepted.push(span);
	}
	return accepted;
}

function positionKey(position: Pos | undefined): string {
	return position ? `${position.start.offset}:${position.end.offset}` : '';
}

function sourceKind(path: string): ImageReferenceSourceKind | null {
	const extension = extensionOf(path);
	if (extension === 'md') return 'markdown';
	if (extension === 'canvas') return 'canvas';
	return null;
}

function samePath(left: string, right: string, caseSensitive: boolean): boolean {
	const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\/+/, '');
	const normalizedLeft = normalize(left);
	const normalizedRight = normalize(right);
	return caseSensitive ? normalizedLeft === normalizedRight : normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

function basenameMatches(candidate: string, oldPath: string, caseSensitive: boolean): boolean {
	const candidateName = basename(candidate);
	if (extensionOf(candidate) === '') return samePath(stripExtension(candidateName), stripExtension(basename(oldPath)), caseSensitive);
	return samePath(candidateName, basename(oldPath), caseSensitive);
}

function resolveRelative(sourcePath: string, target: string): string {
	const normalized = target.replace(/\\/g, '/');
	if (normalized.startsWith('/')) return normalized.replace(/^\/+/, '');
	const segments = (dirname(sourcePath) ? dirname(sourcePath).split('/') : []).concat(normalized.split('/'));
	const resolved: string[] = [];
	for (const segment of segments) {
		if (!segment || segment === '.') continue;
		if (segment === '..') resolved.pop();
		else resolved.push(segment);
	}
	return resolved.join('/');
}

function relativePath(fromDirectory: string, target: string): string {
	const from = fromDirectory ? fromDirectory.split('/').filter(Boolean) : [];
	const to = target.split('/').filter(Boolean);
	let common = 0;
	while (common < from.length && common < to.length && from[common] === to[common]) common++;
	const up = Array.from({ length: from.length - common }, () => '..');
	return up.concat(to.slice(common)).join('/') || basename(target);
}

function dirname(path: string): string {
	const index = path.lastIndexOf('/');
	return index >= 0 ? path.slice(0, index) : '';
}

function basename(path: string): string {
	const index = path.lastIndexOf('/');
	return index >= 0 ? path.slice(index + 1) : path;
}

function stripExtension(path: string): string {
	const name = basename(path);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

function extensionOf(path: string): string {
	const name = basename(path);
	const dot = name.lastIndexOf('.');
	return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isSizePart(part: string): boolean {
	return /^\d+(?=\s|$)/.test(part) || /\d+x\d+/i.test(part);
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function rawReferenceVariants(oldPath: string, caseSensitive: boolean): string[] {
	const variants = new Set<string>();
	const add = (value: string) => {
		const trimmed = value.trim();
		if (trimmed) variants.add(caseSensitive ? trimmed : trimmed.toLowerCase());
	};
	const normalized = oldPath.replace(/\\/g, '/');
	for (const path of [normalized, safeDecode(normalized)]) {
		const encoded = encodeURI(path);
		const component = encodeURIComponent(path);
		add(path);
		add(encoded);
		add(component);
		add(encoded.replace(/%2F/gi, '%2F'));
		add(encoded.replace(/%2F/gi, '%2f'));
		add(component.replace(/%2F/gi, '%2f'));
	}
	for (const name of [basename(normalized), safeDecode(basename(normalized))]) {
		add(name);
		add(encodeURI(name));
		add(encodeURIComponent(name));
	}
	return [...variants];
}

function resolvedPathWithoutLeadingSlash(path: string): string {
	return safeDecode(path).replace(/\\/g, '/').replace(/^\/+/, '').split('#', 1)[0] ?? '';
}

function insideRanges(offset: number, ranges: Range[]): boolean {
	for (const range of ranges) {
		if (offset < range.start) return false;
		if (offset < range.end) return true;
	}
	return false;
}

function overlaps(start: number, end: number, ranges: Range[]): boolean {
	return ranges.some((range) => start < range.end && end > range.start);
}

function mergeRanges(ranges: Range[]): Range[] {
	const merged: Range[] = [];
	for (const range of ranges) {
		const previous = merged.at(-1);
		if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : '未知错误';
}

// `read` bypasses Obsidian's cached read so preflight and self-checks see the
// bytes currently on disk; cachedRead remains the fallback for older hosts and
// for lightweight UI callers.
async function readText(app: ImageReferenceApp, file: ImageReferenceSourceFile): Promise<string> {
	return app.vault.read ? app.vault.read(file) : app.vault.cachedRead(file);
}
