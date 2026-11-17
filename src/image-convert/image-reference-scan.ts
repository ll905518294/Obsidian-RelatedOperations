import { isCaseSensitiveFileSystem } from '../core-utils.ts';
import type {
	ImageReferenceApp,
	ImageReferenceScanResult,
	ImageReferenceSite,
	ImageReferenceSourceFile,
	ImageReferenceSourceKind,
	ParsedCanvas,
	ParsedMarkdownContent,
} from './image-reference-types.ts';
import {
	buildCanvasCandidateHaystack,
	parseCanvasContent,
	parseMarkdownContent,
} from './image-reference-parser.ts';
import {
	analyzeParsedCanvas,
	analyzeParsedMarkdown,
	blockedReasonFor,
	collectCanvasAnalysis,
	collectMarkdownAnalysis,
	countCachedMarkdownReferences,
} from './image-reference-analysis.ts';
import {
	basename,
	hasRawImageReference,
	samePath,
	sourceKind,
	stripExtension,
} from './image-reference-path.ts';

// 扫描编排层：唯一负责读取 vault；解析与分析保持纯函数，便于批量复用。
const IMAGE_MISSING_REASON_TEXT = '图片文件不存在';

/** 笔记路径 → 当前磁盘内容；转换期间由调用方在改写笔记后同步更新。 */
export type ReferenceContentSnapshot = Map<string, string>;

/** 路径是否属于需要纳入引用内容快照的笔记类型（md/canvas 等）。 */
export function isReferenceSourcePath(path: string): boolean {
	return sourceKind(path) !== null;
}

/**
 * 转换开始前一次性真实读盘，建立所有引用源笔记的内容快照。
 * 之后 findRawImageReferenceSources 用该快照做纯内存残留判断，避免每张图
 * 都 getFiles + await read 全库笔记。read 优先，老宿主回退 cachedRead。
 */
export async function readReferenceContentSnapshot(app: ImageReferenceApp): Promise<ReferenceContentSnapshot> {
	const snapshot: ReferenceContentSnapshot = new Map();
	for (const file of app.vault.getFiles()) {
		if (!isReferenceSourcePath(file.path)) continue;
		snapshot.set(file.path, await readText(app, file));
	}
	return snapshot;
}

export async function findImageReferences(
	app: ImageReferenceApp,
	sourcePath: string,
	caseSensitive = isCaseSensitiveFileSystem(),
): Promise<ImageReferenceScanResult> {
	const files = app.vault.getFiles();
	if (!files.some((file) => file.path === sourcePath)) {
		return { ok: false, reason: 'unsupported-source', reasonText: IMAGE_MISSING_REASON_TEXT };
	}
	const allPaths = files.map((file) => file.path);
	const sites: ImageReferenceSite[] = [];
	let totalLiveRefs = 0;
	let totalTextMentions = 0;
	for (const file of files) {
		const kind = sourceKind(file.path);
		if (!kind) continue;
		const content = await readText(app, file);
		const parsed = parseSourceContent(content, kind);
		if (parsed.kind === 'canvas-error') {
			return { ok: false, reason: 'unsupported-source', reasonText: parsed.error, sourcePath: file.path };
		}
		const evaluation = evaluateParsedSourceForTarget(app, file, parsed, content, sourcePath, caseSensitive, allPaths);
		if (evaluation.kind === 'blocked') return evaluation.result;
		if (evaluation.kind === 'site') {
			sites.push(evaluation.site);
			totalLiveRefs += evaluation.site.liveRefs;
			totalTextMentions += evaluation.site.textMentions;
		}
	}
	return { ok: true, sites, totalLiveRefs, totalTextMentions };
}

/*
 * 一次遍历、每篇笔记只读取和解析一次，为所有图片目标累积引用结果。
 * 单图语义（缺失目标、Canvas 解析失败、blocked、count-mismatch 的首个
 * sourcePath 与 reason）与 findImageReferences 完全一致：一旦某个目标在
 * 某篇笔记上被阻断或报错，它不再参与后续笔记的评估。
 */
export async function findImageReferencesBatch(
	app: ImageReferenceApp,
	targets: string[],
	caseSensitive = isCaseSensitiveFileSystem(),
): Promise<Map<string, ImageReferenceScanResult>> {
	const files = app.vault.getFiles();
	const allPaths = files.map((file) => file.path);
	const results = new Map<string, ImageReferenceScanResult>();
	const active = new Set<string>();
	const siteLists = new Map<string, ImageReferenceSite[]>();
	const totals = new Map<string, { liveRefs: number; textMentions: number }>();
	for (const target of targets) {
		if (!files.some((file) => file.path === target)) {
			results.set(target, { ok: false, reason: 'unsupported-source', reasonText: IMAGE_MISSING_REASON_TEXT });
			continue;
		}
		results.set(target, { ok: true, sites: [], totalLiveRefs: 0, totalTextMentions: 0 });
		active.add(target);
		siteLists.set(target, []);
		totals.set(target, { liveRefs: 0, textMentions: 0 });
	}
	for (const file of files) {
		if (active.size === 0) break;
		const kind = sourceKind(file.path);
		if (!kind) continue;
		const content = await readText(app, file);
		const parsed = parseSourceContent(content, kind);
		if (parsed.kind === 'canvas-error') {
			const errorResult: ImageReferenceScanResult = {
				ok: false,
				reason: 'unsupported-source',
				reasonText: parsed.error,
				sourcePath: file.path,
			};
			for (const target of active) results.set(target, errorResult);
			active.clear();
			continue;
		}
		let resolvedKeys: Set<string> | null = null;
		for (const target of [...active]) {
			// 倒排剪枝：只有笔记内容（含解码形式）可能提到该目标，或
			// resolvedLinks 索引明确记录了它时，才进入完整分析。
			const targetStem = targetStemOf(target);
			if (!parsed.haystack.includes(targetStem)) {
				if (resolvedKeys === null) resolvedKeys = buildResolvedKeySet(app, file, caseSensitive);
				if (!resolvedKeys.has(targetKeyOf(target, caseSensitive))) continue;
			}
			const evaluation = evaluateParsedSourceForTarget(app, file, parsed, content, target, caseSensitive, allPaths);
			if (evaluation.kind === 'blocked') {
				results.set(target, evaluation.result);
				active.delete(target);
				continue;
			}
			if (evaluation.kind === 'site') {
				siteLists.get(target)!.push(evaluation.site);
				const total = totals.get(target)!;
				total.liveRefs += evaluation.site.liveRefs;
				total.textMentions += evaluation.site.textMentions;
			}
		}
	}
	for (const target of active) {
		results.set(target, {
			ok: true,
			sites: siteLists.get(target) ?? [],
			totalLiveRefs: totals.get(target)?.liveRefs ?? 0,
			totalTextMentions: totals.get(target)?.textMentions ?? 0,
		});
	}
	return results;
}

type ParsedSource =
	| { kind: 'markdown'; parsed: ParsedMarkdownContent; haystack: string }
	| { kind: 'canvas'; parsed: Extract<ParsedCanvas, { ok: true }>; haystack: string };

type CanvasParseFailure = { kind: 'canvas-error'; error: string };

type SourceEvaluation =
	| { kind: 'blocked'; result: ImageReferenceScanResult }
	| { kind: 'site'; site: ImageReferenceSite }
	| { kind: 'none' };

function parseSourceContent(content: string, kind: ImageReferenceSourceKind): ParsedSource | CanvasParseFailure {
	if (kind === 'canvas') {
		const parsed = parseCanvasContent(content);
		if (!parsed.ok) return { kind: 'canvas-error', error: parsed.error };
		return { kind: 'canvas', parsed, haystack: buildCanvasCandidateHaystack(parsed) };
	}
	const md = parseMarkdownContent(content);
	return { kind: 'markdown', parsed: md, haystack: md.candidateHaystack };
}

function targetStemOf(target: string): string {
	return stripExtension(basename(target.replace(/\\/g, '/'))).toLowerCase();
}

function targetKeyOf(target: string, caseSensitive: boolean): string {
	const normalized = target.replace(/\\/g, '/').replace(/^\/+/, '');
	return caseSensitive ? normalized : normalized.toLowerCase();
}

function buildResolvedKeySet(app: ImageReferenceApp, file: ImageReferenceSourceFile, caseSensitive: boolean): Set<string> {
	const record = app.metadataCache.resolvedLinks?.[file.path];
	const keys = new Set<string>();
	if (record) {
		for (const [key, value] of Object.entries(record)) {
			if (typeof value !== 'number' || value <= 0) continue;
			keys.add(targetKeyOf(key, caseSensitive));
		}
	}
	return keys;
}

/*
 * 对“已解析的某篇笔记 + 某个图片目标”做与单图扫描相同的判定：解析失败、
 * blocked、markdown 的缓存一致性校验、索引数量校验，以及站点累积。
 */
function evaluateParsedSourceForTarget(
	app: ImageReferenceApp,
	file: ImageReferenceSourceFile,
	source: ParsedSource,
	content: string,
	targetPath: string,
	caseSensitive: boolean,
	allPaths: string[],
): SourceEvaluation {
	const expected = resolvedReferenceCount(app.metadataCache.resolvedLinks?.[file.path], targetPath, caseSensitive);
	const resolver = (link: string) => app.metadataCache.getFirstLinkpathDest(link, file.path)?.path ?? null;
	const collected = source.kind === 'canvas'
		? analyzeParsedCanvas(source.parsed, targetPath, file.path, resolver, allPaths, caseSensitive)
		: analyzeParsedMarkdown(source.parsed, targetPath, file.path, resolver, allPaths, caseSensitive);
	if (collected.analysis.error) {
		return {
			kind: 'blocked',
			result: { ok: false, reason: 'unsupported-source', reasonText: collected.analysis.error, sourcePath: file.path },
		};
	}
	const blocked = blockedReasonFor(collected.analysis);
	if (blocked) return { kind: 'blocked', result: { ok: false, ...blocked, sourcePath: file.path } };

	let liveRefs = collected.analysis.liveRefs;
	if (source.kind === 'markdown' && (liveRefs > 0 || expected > 0)) {
		const cached = countCachedMarkdownReferences(app, file, targetPath, content, caseSensitive);
		if (cached === null) {
			return {
				kind: 'blocked',
				result: { ok: false, reason: 'count-mismatch', reasonText: `${file.path} 的元数据尚未就绪`, sourcePath: file.path },
			};
		}
		const expectedLiveRefs = cached + collected.analysis.htmlRefs;
		if (expectedLiveRefs !== liveRefs) {
			return {
				kind: 'blocked',
				result: {
					ok: false,
					reason: 'count-mismatch',
					reasonText: `${file.path} 的缓存与文本引用数量不一致（缓存 ${expectedLiveRefs}，文本 ${liveRefs}）`,
					sourcePath: file.path,
				},
			};
		}
		liveRefs = expectedLiveRefs;
	}
	// Obsidian 不保证 Canvas 的引用进入 resolvedLinks；Canvas 始终以文本
	// 枚举为准，只有索引明确记录了该图片时才要求两者一致。
	if ((source.kind === 'markdown' || expected > 0) && liveRefs !== expected) {
		return {
			kind: 'blocked',
			result: {
				ok: false,
				reason: 'count-mismatch',
				reasonText: `${file.path} 的引用数量与索引不一致（索引 ${expected}，定位 ${liveRefs}）`,
				sourcePath: file.path,
			},
		};
	}
	if (liveRefs > 0) {
		return {
			kind: 'site',
			site: { sourcePath: file.path, sourceKind: source.kind, liveRefs, textMentions: collected.analysis.textMentions },
		};
	}
	return { kind: 'none' };
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

export async function findRawImageReferenceSources(
	app: ImageReferenceApp,
	targetPath: string,
	caseSensitive = isCaseSensitiveFileSystem(),
	snapshot?: ReferenceContentSnapshot,
): Promise<string[]> {
	const sources: string[] = [];
	if (snapshot) {
		// 快照模式：纯内存查询，不触碰磁盘。集合与老逻辑一致（仅 sourceKind 笔记，
		// 快照键即转换开始时 getFiles 里的全部 md/canvas 路径）。
		for (const [path, content] of snapshot) {
			if (!isReferenceSourcePath(path)) continue;
			if (hasRawImageReference(content, targetPath, caseSensitive)) sources.push(path);
		}
		return sources;
	}
	for (const file of app.vault.getFiles()) {
		if (!isReferenceSourcePath(file.path)) continue;
		const content = await readText(app, file);
		if (hasRawImageReference(content, targetPath, caseSensitive)) sources.push(file.path);
	}
	return sources;
}

// `read` bypasses Obsidian's cached read so preflight and self-checks see the
// bytes currently on disk; cachedRead remains the fallback for older hosts and
// for lightweight UI callers.
async function readText(app: ImageReferenceApp, file: ImageReferenceSourceFile): Promise<string> {
	return app.vault.read ? app.vault.read(file) : app.vault.cachedRead(file);
}
