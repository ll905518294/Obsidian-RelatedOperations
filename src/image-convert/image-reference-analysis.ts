import type { Pos } from 'obsidian';
import { isCaseSensitiveFileSystem } from '../core-utils.ts';
import type {
	CanvasAnalysis,
	CollectedAnalysis,
	ImageContentAnalysis,
	ImageReferenceApp,
	ImageReferenceBlockReason,
	ImageReferenceContext,
	ImageReferenceSourceFile,
	ImageReferenceSourceKind,
	ParsedCanvas,
	ParsedCodeMention,
	ParsedMarkdownContent,
	Range,
	ReferenceSpan,
} from './image-reference-types.ts';
import { frontmatterRange, parseCanvasContent, parseMarkdownContent } from './image-reference-parser.ts';
import {
	basename,
	extensionOf,
	hasRawImageReference,
	isSizePart,
	overlaps,
	resolvePathStyle,
	resolvedPathWithoutLeadingSlash,
	safeDecode,
	samePath,
	stripExtension,
} from './image-reference-path.ts';

// 分析层复用解析结果与路径判定；同一篇内容可对多个目标复用，避免重复解析。
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
		context?.caseSensitive ?? isCaseSensitiveFileSystem(),
	).liveRefs;
}

export function collectMarkdownAnalysis(
	content: string,
	oldPath: string,
	sourcePath: string,
	resolveLink: ((linkPath: string) => string | null) | undefined,
	vaultPaths: string[] | undefined,
	caseSensitive: boolean,
): CollectedAnalysis {
	return analyzeParsedMarkdown(parseMarkdownContent(content), oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive);
}

export function analyzeParsedMarkdown(
	parsed: ParsedMarkdownContent,
	oldPath: string,
	sourcePath: string,
	resolveLink: ((linkPath: string) => string | null) | undefined,
	vaultPaths: string[] | undefined,
	caseSensitive: boolean,
): CollectedAnalysis {
	const occupied: Range[] = [];
	const spans: ReferenceSpan[] = [];
	const noExtensionRefs: string[] = [];
	const analysis = emptyImageContentAnalysis();

	for (const value of parsed.cssUrls) {
		if (resolvePathStyle(value, oldPath, sourcePath, false, resolveLink, vaultPaths, caseSensitive)) {
			analysis.hasCssUrl = true;
		}
	}
	for (const source of parsed.htmlSources) {
		if ((source.src && resolvePathStyle(source.src.value, oldPath, sourcePath, false, resolveLink, vaultPaths, caseSensitive))
			|| (source.srcset && srcsetMentions(source.srcset.value, oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive))) {
			analysis.hasHtmlSource = true;
		}
	}
	if (sourcePath.toLowerCase().endsWith('.excalidraw.md')) {
		analysis.hasCodeBlockReference = parsed.codeRanges.some((range) =>
			hasRawImageReference(range.text, oldPath, caseSensitive));
	}

	for (const wiki of parsed.wiki) {
		const resolved = resolvePathStyle(wiki.target, oldPath, sourcePath, true, resolveLink, vaultPaths, caseSensitive);
		if (!resolved) continue;
		analysis.liveRefs++;
		if (wiki.size) analysis.hasSize = true;
		if (extensionOf(wiki.target) === '' && !wiki.target.includes('/')) noExtensionRefs.push(wiki.target);
		spans.push({
			start: wiki.inFrontmatter ? wiki.targetStart : wiki.start,
			end: wiki.inFrontmatter ? wiki.targetEnd : wiki.end,
			kind: wiki.inFrontmatter ? 'wiki-frontmatter' : 'wiki-body',
			rawTarget: wiki.target,
			allowBareName: true,
			wiki: {
				alias: wiki.params.find((part) => !isSizePart(part)) ?? '',
				bang: wiki.bang,
				originalTarget: wiki.target,
			},
		});
		occupied.push({ start: wiki.start, end: wiki.end });
	}

	for (const markdown of parsed.markdown) {
		if (overlaps(markdown.start, markdown.end, occupied)) continue;
		const resolved = resolvePathStyle(markdown.targetRaw, oldPath, sourcePath, false, resolveLink, vaultPaths, caseSensitive);
		if (!resolved) continue;
		analysis.liveRefs++;
		spans.push({ start: markdown.targetStart, end: markdown.targetEnd, kind: 'markdown', rawTarget: markdown.targetRaw, allowBareName: false });
		occupied.push({ start: markdown.start, end: markdown.end });
	}

	for (const value of parsed.srcsets) {
		if (srcsetMentions(value, oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive)) analysis.hasSrcset = true;
	}
	for (const image of parsed.htmlImages) {
		if (overlaps(image.tagStart, image.tagStart + image.tag.length, occupied)) continue;
		if (image.srcset && (srcsetMentions(image.srcset.value, oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive)
			|| (image.src && resolvePathStyle(image.src.value, oldPath, sourcePath, false, resolveLink, vaultPaths, caseSensitive)))) {
			analysis.hasSrcset = true;
		}
		if (!image.src) {
			if (image.tag.includes(basename(oldPath))) analysis.hasUnsupportedHtml = true;
			continue;
		}
		const resolved = resolvePathStyle(image.src.value, oldPath, sourcePath, false, resolveLink, vaultPaths, caseSensitive);
		if (!resolved) continue;
		const targetStart = image.tagStart + image.src.valueStart;
		const targetEnd = image.tagStart + image.src.valueEnd;
		analysis.liveRefs++;
		analysis.htmlRefs++;
		spans.push({ start: targetStart, end: targetEnd, kind: 'html', rawTarget: image.src.value, allowBareName: false });
		occupied.push({ start: image.tagStart, end: image.tagStart + image.tag.length });
	}

	for (const value of parsed.frontmatterValues) {
		if (overlaps(value.tokenStart, value.tokenEnd, occupied)) continue;
		if (resolvePathStyle(value.token, oldPath, sourcePath, true, resolveLink, vaultPaths, caseSensitive)) {
			analysis.hasFrontmatterPlainPath = true;
			analysis.liveRefs++;
		}
	}

	for (const range of parsed.codeRanges) {
		analysis.textMentions += countParsedMentions(range.mentions, oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive);
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

export function collectCanvasAnalysis(
	content: string,
	oldPath: string,
	sourcePath: string,
	resolveLink: ((linkPath: string) => string | null) | undefined,
	vaultPaths: string[] | undefined,
	caseSensitive: boolean,
): CanvasAnalysis {
	const parsed = parseCanvasContent(content);
	if (!parsed.ok) return { analysis: emptyImageContentAnalysis(parsed.error), spans: [] };
	return analyzeParsedCanvas(parsed, oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive);
}

export function analyzeParsedCanvas(
	parsed: Extract<ParsedCanvas, { ok: true }>,
	oldPath: string,
	sourcePath: string,
	resolveLink: ((linkPath: string) => string | null) | undefined,
	vaultPaths: string[] | undefined,
	caseSensitive: boolean,
): CanvasAnalysis {
	const analysis = emptyImageContentAnalysis();
	for (const node of parsed.nodes) {
		if (typeof node.file === 'string'
			&& resolvePathStyle(node.file, oldPath, sourcePath, false, resolveLink, vaultPaths, caseSensitive)) {
			analysis.liveRefs++;
		}
		if (node.textParsed) {
			const nested = analyzeParsedMarkdown(node.textParsed, oldPath, sourcePath, resolveLink, vaultPaths, caseSensitive);
			if (nested.analysis.liveRefs > 0 || nested.analysis.hasSize || nested.analysis.hasSrcset
				|| nested.analysis.hasFrontmatterPlainPath || nested.analysis.hasUnsupportedHtml) {
				analysis.hasCanvasTextEmbed = true;
			}
			analysis.textMentions += nested.analysis.textMentions;
		}
	}
	return { analysis, spans: [], data: parsed.data };
}

export function countCachedMarkdownReferences(
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

export function blockedReasonFor(analysis: ImageContentAnalysis): { reason: ImageReferenceBlockReason; reasonText: string } | null {
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

function countParsedMentions(
	mentions: ParsedCodeMention[],
	oldPath: string,
	sourcePath: string,
	resolveLink: ((linkPath: string) => string | null) | undefined,
	vaultPaths: string[] | undefined,
	caseSensitive: boolean,
): number {
	let count = 0;
	const seen: Range[] = [];
	for (const mention of mentions) {
		if (mention.kind === 'wiki') {
			if (resolvePathStyle(mention.text, oldPath, sourcePath, true, resolveLink, vaultPaths, caseSensitive)) {
				count++;
				seen.push({ start: mention.start, end: mention.end });
			}
			continue;
		}
		if (overlaps(mention.start, mention.end, seen)) continue;
		if (resolvePathStyle(mention.text, oldPath, sourcePath, mention.kind === 'bare', resolveLink, vaultPaths, caseSensitive)) {
			count++;
			if (mention.kind === 'markdown') seen.push({ start: mention.start, end: mention.end });
		}
	}
	return count;
}

function emptyImageContentAnalysis(error?: string): ImageContentAnalysis {
	return {
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
		...(error ? { error } : {}),
	};
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

function dedupeSpans(spans: ReferenceSpan[]): ReferenceSpan[] {
	const sorted = [...spans].sort((left, right) => left.start - right.start || right.end - left.end);
	const accepted: ReferenceSpan[] = [];
	for (const span of sorted) {
		const previous = accepted[accepted.length - 1];
		if (previous && span.start < previous.end) continue;
		accepted.push(span);
	}
	return accepted;
}

function positionKey(position: Pos | undefined): string {
	return position ? `${position.start.offset}:${position.end.offset}` : '';
}
