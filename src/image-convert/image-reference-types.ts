import type { CachedMetadata } from 'obsidian';

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

export interface Range {
	start: number;
	end: number;
}

export type PathStyle = 'absolute' | 'basename' | 'relative' | 'vault';
export type RewriteKind = 'canvas' | 'markdown';

export interface WikiSpanInfo {
	alias: string;
	bang: boolean;
	originalTarget: string;
}

export interface ReferenceSpan extends Range {
	allowBareName: boolean;
	kind: 'html' | 'markdown' | 'wiki-body' | 'wiki-frontmatter';
	rawTarget: string;
	wiki?: WikiSpanInfo;
}

export interface CollectedAnalysis {
	analysis: ImageContentAnalysis;
	spans: ReferenceSpan[];
}

export interface CanvasAnalysis extends CollectedAnalysis {
	data?: Record<string, unknown>;
}

export interface AttributeRange {
	value: string;
	valueStart: number;
	valueEnd: number;
}

export interface ParsedWikiReference {
	start: number;
	end: number;
	target: string;
	targetStart: number;
	targetEnd: number;
	params: string[];
	size: boolean;
	bang: boolean;
	inFrontmatter: boolean;
}

export interface ParsedMarkdownReference {
	start: number;
	end: number;
	targetRaw: string;
	targetStart: number;
	targetEnd: number;
}

export interface ParsedHtmlImage {
	tagStart: number;
	tag: string;
	src: AttributeRange | null;
	srcset: AttributeRange | null;
}

export interface ParsedHtmlSource {
	src: AttributeRange | null;
	srcset: AttributeRange | null;
}

export interface ParsedFrontmatterValue {
	token: string;
	tokenStart: number;
	tokenEnd: number;
}

export interface ParsedCodeMention {
	kind: 'bare' | 'markdown' | 'wiki';
	text: string;
	start: number;
	end: number;
}

export interface ParsedCodeRange {
	text: string;
	mentions: ParsedCodeMention[];
}

export interface ParsedMarkdownContent {
	code: Range[];
	htmlTags: Range[];
	frontmatter: Range | null;
	cssUrls: string[];
	htmlSources: ParsedHtmlSource[];
	wiki: ParsedWikiReference[];
	markdown: ParsedMarkdownReference[];
	srcsets: string[];
	htmlImages: ParsedHtmlImage[];
	frontmatterValues: ParsedFrontmatterValue[];
	codeRanges: ParsedCodeRange[];
	candidateHaystack: string;
}

export interface ParsedCanvasNode {
	file?: unknown;
	text?: unknown;
	type?: unknown;
	textParsed?: ParsedMarkdownContent;
}

export type ParsedCanvas =
	| { ok: true; data: Record<string, unknown>; nodes: ParsedCanvasNode[] }
	| { ok: false; error: string };
