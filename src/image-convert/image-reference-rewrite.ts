import { isCaseSensitiveFileSystem } from '../core-utils.ts';
import type {
	ImageReferenceContext,
	ImageReferenceRewriteResult,
	ImageReferenceSourceKind,
} from './image-reference-types.ts';
import {
	blockedReasonFor,
	collectCanvasAnalysis,
	collectMarkdownAnalysis,
} from './image-reference-analysis.ts';
import { createMatcher, wikiBodyReplacement } from './image-reference-path.ts';

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
