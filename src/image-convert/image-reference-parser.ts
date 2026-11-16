import type {
	AttributeRange,
	ParsedCanvas,
	ParsedCanvasNode,
	ParsedCodeMention,
	ParsedCodeRange,
	ParsedFrontmatterValue,
	ParsedHtmlImage,
	ParsedHtmlSource,
	ParsedMarkdownContent,
	ParsedMarkdownReference,
	ParsedWikiReference,
	Range,
} from './image-reference-types.ts';
import {
	insideRanges,
	isSizePart,
	markdownTargetOffset,
	mergeRanges,
	reasonOf,
	safeDecode,
	wikiTarget,
} from './image-reference-path.ts';

const WIKI_PATTERN = /(!?)\[\[([^\]\n]+)\]\]/g;
const MARKDOWN_LINK_PATTERN = /!?\[[^\x5D\n]*\]\(\s*(<[^>\n]*>|(?:[^()\s]|\([^()\n]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const HTML_IMG_PATTERN = /<img\b[^>]*>/gi;
const HTML_SOURCE_PATTERN = /<source\b[^>]*>/gi;
const HTML_TAG_PATTERN = /<[a-z][^>]*>/gi;
const HTML_SRCSET_PATTERN = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const CSS_URL_PATTERN = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
const FRONTMATTER_VALUE_PATTERN = /(^|[\s:[{,-])(?:"([^"\n]*)"|'([^'\n]*)'|([^\s,\x5B\x5D{}#]+))/g;

/*
 * Parsing and target matching are split so a multi-image scan can parse each
 * note once and then evaluate it against every referenced image. The parser
 * only extracts content-local facts; resolution against a specific old path
 * stays in analyzeParsedMarkdown.
 */
export function parseMarkdownContent(content: string): ParsedMarkdownContent {
	const code = codeRanges(content);
	const htmlTags = htmlTagRanges(content, code);
	const frontmatter = frontmatterRange(content);
	const cssUrls: string[] = [];
	const htmlSources: ParsedHtmlSource[] = [];
	const wiki: ParsedWikiReference[] = [];
	const markdown: ParsedMarkdownReference[] = [];
	const srcsets: string[] = [];
	const htmlImages: ParsedHtmlImage[] = [];
	const frontmatterValues: ParsedFrontmatterValue[] = [];

	for (const match of content.matchAll(CSS_URL_PATTERN)) {
		const start = match.index ?? 0;
		if (insideRanges(start, code)) continue;
		const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
		if (value) cssUrls.push(value);
	}
	for (const match of content.matchAll(HTML_SOURCE_PATTERN)) {
		const start = match.index ?? 0;
		if (insideRanges(start, code)) continue;
		const tag = match[0];
		htmlSources.push({ src: attributeRange(tag, 'src'), srcset: attributeRange(tag, 'srcset') });
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
		wiki.push({
			start,
			end,
			target,
			targetStart,
			targetEnd,
			params,
			size: params.some(isSizePart),
			bang,
			inFrontmatter: !!frontmatter && targetStart >= frontmatter.start && targetEnd <= frontmatter.end,
		});
	}
	for (const match of content.matchAll(MARKDOWN_LINK_PATTERN)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (insideRanges(start, code) || insideRanges(start, htmlTags)) continue;
		const targetRaw = match[1];
		if (!targetRaw) continue;
		const targetStart = start + markdownTargetOffset(match[0]);
		const targetEnd = targetStart + targetRaw.length;
		if (targetStart < start || targetEnd > end) continue;
		markdown.push({ start, end, targetRaw, targetStart, targetEnd });
	}
	for (const match of content.matchAll(HTML_SRCSET_PATTERN)) {
		const start = match.index ?? 0;
		if (insideRanges(start, code)) continue;
		const value = match[1] ?? match[2] ?? match[3] ?? '';
		if (value) srcsets.push(value);
	}
	for (const match of content.matchAll(HTML_IMG_PATTERN)) {
		const tagStart = match.index ?? 0;
		const tag = match[0];
		if (insideRanges(tagStart, code)) continue;
		htmlImages.push({ tagStart, tag, src: attributeRange(tag, 'src'), srcset: attributeRange(tag, 'srcset') });
	}
	if (frontmatter) {
		const body = content.slice(frontmatter.start, frontmatter.end);
		for (const match of body.matchAll(FRONTMATTER_VALUE_PATTERN)) {
			const token = match[2] ?? match[3] ?? match[4] ?? '';
			if (!token || token.endsWith(':') || token.includes(':') || token.includes('[[') || token.startsWith('#')) continue;
			const tokenStart = frontmatter.start + (match.index ?? 0) + match[0].length - token.length - (match[2] !== undefined || match[3] !== undefined ? 1 : 0);
			const tokenEnd = tokenStart + token.length;
			if (insideRanges(tokenStart, code) || insideRanges(tokenStart, htmlTags)) continue;
			frontmatterValues.push({ token, tokenStart, tokenEnd });
		}
	}
	const parsedCode: ParsedCodeRange[] = [];
	for (const range of code) {
		const text = content.slice(range.start, range.end);
		const mentions: ParsedCodeMention[] = [];
		for (const match of text.matchAll(WIKI_PATTERN)) {
			const start = match.index ?? 0;
			const target = wikiTarget(match);
			if (target) mentions.push({ kind: 'wiki', text: target, start, end: start + match[0].length });
		}
		for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
			const start = match.index ?? 0;
			const target = match[1];
			if (target) mentions.push({ kind: 'markdown', text: target, start, end: start + match[0].length });
		}
		for (const match of text.matchAll(/[^\s`"'<>\x5B\x5D()]+/g)) {
			const start = match.index ?? 0;
			mentions.push({ kind: 'bare', text: match[0], start, end: start + match[0].length });
		}
		parsedCode.push({ text, mentions });
	}
	return {
		code,
		htmlTags,
		frontmatter,
		cssUrls,
		htmlSources,
		wiki,
		markdown,
		srcsets,
		htmlImages,
		frontmatterValues,
		codeRanges: parsedCode,
		candidateHaystack: buildCandidateHaystack({
			cssUrls,
			htmlSources,
			wiki,
			markdown,
			srcsets,
			htmlImages,
			frontmatterValues,
			codeRanges: parsedCode,
		}),
	};
}

/*
 * 倒排候选索引：把一篇笔记中所有会被 resolvePathStyle 检查的链接文本
 * （含解码形式与 HTML 标签原文）拼成一个小 haystack。批量扫描时先用
 * 目标文件名的主干做子串检查，只有可能命中的目标才进入完整分析，
 * 避免“每张图都对全库做一遍解析后分析”。
 */
function buildCandidateHaystack(parsed: {
	cssUrls: string[];
	htmlSources: ParsedHtmlSource[];
	wiki: ParsedWikiReference[];
	markdown: ParsedMarkdownReference[];
	srcsets: string[];
	htmlImages: ParsedHtmlImage[];
	frontmatterValues: ParsedFrontmatterValue[];
	codeRanges: ParsedCodeRange[];
}): string {
	const parts: string[] = [];
	const add = (text: string) => {
		if (!text) return;
		parts.push(text.toLowerCase());
		const decoded = safeDecode(text);
		if (decoded !== text) parts.push(decoded.toLowerCase());
	};
	for (const url of parsed.cssUrls) add(url);
	for (const source of parsed.htmlSources) {
		if (source.src) add(source.src.value);
		if (source.srcset) add(source.srcset.value);
	}
	for (const ref of parsed.wiki) add(ref.target);
	for (const ref of parsed.markdown) add(ref.targetRaw);
	for (const value of parsed.srcsets) add(value);
	for (const image of parsed.htmlImages) {
		add(image.tag);
		if (image.src) add(image.src.value);
		if (image.srcset) add(image.srcset.value);
	}
	for (const value of parsed.frontmatterValues) add(value.token);
	for (const range of parsed.codeRanges) {
		for (const mention of range.mentions) add(mention.text);
	}
	return parts.join('\n');
}

export function buildCanvasCandidateHaystack(parsed: Extract<ParsedCanvas, { ok: true }>): string {
	const parts: string[] = [];
	for (const node of parsed.nodes) {
		if (typeof node.file === 'string') parts.push(node.file.toLowerCase());
		if (node.textParsed) parts.push(node.textParsed.candidateHaystack);
	}
	return parts.join('\n');
}

export function parseCanvasContent(content: string): ParsedCanvas {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(content) as Record<string, unknown>;
	} catch (error) {
		return { ok: false, error: `Canvas JSON 解析失败：${reasonOf(error)}` };
	}
	const nodes = Array.isArray(data.nodes) ? data.nodes : [];
	const parsedNodes: ParsedCanvasNode[] = [];
	for (const node of nodes) {
		if (!node || typeof node !== 'object') {
			parsedNodes.push({});
			continue;
		}
		const record = node as Record<string, unknown>;
		parsedNodes.push({
			file: record.file,
			text: record.text,
			type: record.type,
			textParsed: record.type === 'text' && typeof record.text === 'string'
				? parseMarkdownContent(record.text)
				: undefined,
		});
	}
	return { ok: true, data, nodes: parsedNodes };
}

export function frontmatterRange(content: string): Range | null {
	const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
	if (!match || !match[1]) return null;
	const start = (match.index ?? 0) + match[0].indexOf(match[1]);
	return { start, end: start + match[1].length };
}

function attributeRange(tag: string, name: string): AttributeRange | null {
	const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`, 'i');
	const match = pattern.exec(tag);
	if (!match) return null;
	const value = match[1] ?? match[2] ?? match[3] ?? '';
	const quote = match[1] !== undefined || match[2] !== undefined ? 1 : 0;
	const tokenStart = (match.index ?? 0) + match[0].length - value.length - quote;
	return { value, valueStart: tokenStart, valueEnd: tokenStart + value.length };
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
