import type { CachedMetadata } from 'obsidian';
import { isCaseSensitiveFileSystem } from '../core-utils.ts';
import { LARGE_IMAGE_BYTES, type ImageCodec } from './image-codec.ts';
import type { ImageConvertTarget } from './image-convert-plan.ts';
import { pathKey, sourceImageFormat, targetPathFor } from './image-convert-plan.ts';
import {
	analyzeReferenceContent,
	countLiveReferencesInVault,
	countRemainingReferences,
	findImageReferences,
	findImageReferencesBatch,
	findRawImageReferenceSources,
	hasRawImageReference,
	rewriteImageReferences,
	readReferenceContentSnapshot,
	type ReferenceContentSnapshot,
	type ImageReferenceSite,
	type ImageReferenceSourceKind,
	type ImageReferenceScanResult,
} from './image-convert-links.ts';

const DEFAULT_CONVERSION_CONCURRENCY = 8;
const MAX_CONVERSION_CONCURRENCY = 8;

interface SourceNoteLock {
	tail: Promise<void>;
}

type NoteStatBaseline = Map<string, { size: number; mtime: number }>;

export function appWithSnapshot(app: ConversionApp, snapshot: ReferenceContentSnapshot): ConversionApp {
	// 不要用对象展开复刻 vault：真实 Obsidian 的 Vault 方法（getFiles 等）在原型上，
	// 展开只复制自有可枚举属性，会丢失原型链。用 Object.create 继承全部原型与自有属性，
	// 再仅覆盖 read（快照命中优先，miss 时以原 this 回退真实读盘）。
	const wrappedApp = Object.create(app) as ConversionApp;
	const originalVault = app.vault;
	const wrappedVault = Object.create(originalVault) as ConversionApp['vault'];
	Object.defineProperty(wrappedVault, 'read', {
		value: (file: ConversionFile) => snapshot.get(file.path) ?? originalVault.read(file),
		writable: true,
		configurable: true,
	});
	Object.defineProperty(wrappedApp, 'vault', {
		value: wrappedVault,
		writable: true,
		configurable: true,
	});
	return wrappedApp;
}

function noteStatBaseline(app: ConversionApp, paths: Iterable<string>, caseSensitive: boolean): NoteStatBaseline {
	const baseline: NoteStatBaseline = new Map();
	for (const path of paths) {
		const file = findFile(app, path, caseSensitive);
		if (file) baseline.set(file.path, { size: file.stat.size, mtime: file.stat.mtime });
	}
	return baseline;
}

function indexedInboundSources(app: ConversionApp, targetPath: string, caseSensitive: boolean): string[] {
	const targetKey = pathKey(targetPath, caseSensitive);
	const sources: string[] = [];
	for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks ?? {})) {
		for (const linkPath of Object.keys(links)) {
			const resolved = app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath)?.path ?? linkPath;
			if (pathKey(resolved, caseSensitive) === targetKey) {
				sources.push(sourcePath);
				break;
			}
		}
	}
	return sources;
}

interface ConversionFile {
	path: string;
	extension: string;
	stat: { size: number; mtime: number };
}

export interface ConversionApp {
	vault: {
		getFiles(): ConversionFile[];
		getFileByPath(path: string): ConversionFile | null;
		cachedRead(file: ConversionFile): Promise<string>;
		read(file: ConversionFile): Promise<string>;
		readBinary(file: ConversionFile): Promise<ArrayBuffer>;
		process(file: ConversionFile, change: (content: string) => string): Promise<string>;
		createBinary(path: string, bytes: ArrayBuffer): Promise<ConversionFile>;
		delete(file: ConversionFile): Promise<void>;
	};
	metadataCache: {
		resolvedLinks: Record<string, Record<string, number>>;
		getFileCache(file: ConversionFile): CachedMetadata | null;
		getFirstLinkpathDest(link: string, sourcePath: string): { path: string } | null;
	};
	fileManager: {
		trashFile(file: ConversionFile): Promise<void>;
	};
}

interface ConversionItem {
	path: string;
	size: number;
	mtime?: number;
	targetPath?: string;
}

interface ConversionOptions {
	target: ImageConvertTarget;
	quality?: number;
	signal?: AbortSignal;
	caseSensitive?: boolean;
	alpha?: 'flatten' | 'skip';
	concurrency?: number;
}

interface ConvertedImage {
	path: string;
	newPath: string;
	oldBytes: number;
	newBytes: number;
}

interface ConversionSkip {
	path: string;
	reason: string;
	reasonText: string;
}

interface ConversionFailure extends ConversionSkip {
	canRetryTrash?: boolean;
	newPath?: string;
}

export interface ConversionResult {
	converted: ConvertedImage[];
	skipped: ConversionSkip[];
	failed: ConversionFailure[];
	pendingTrash: Array<{ path: string; newPath: string }>;
	savedBytes: number;
	aborted: boolean;
	unrestored: string[];
	keptNewFile?: boolean;
	keptNewFilePath?: string;
	blockedReason?: string;
	reasonText?: string;
}

interface Outcome {
	converted?: ConvertedImage;
	skipped?: ConversionSkip;
	failed?: ConversionFailure;
	unrestored?: string[];
	keptNewFilePath?: string;
}

interface OriginalContent {
	before: string;
	after: string;
}

interface RestoreResult {
	failures: string[];
	unrestored: string[];
}

let activeRun = false;

export async function runImageConversion(
	app: ConversionApp,
	codec: ImageCodec,
	items: ConversionItem[],
	options: ConversionOptions,
	onProgress?: (processed: number, total: number, currentPath: string) => void,
): Promise<ConversionResult> {
	if (activeRun) {
		return {
			converted: [],
			skipped: [],
			failed: [],
			pendingTrash: [],
			savedBytes: 0,
			aborted: false,
			unrestored: [],
			blockedReason: 'busy',
			reasonText: '已有转换任务在进行',
		};
	}
	activeRun = true;
	try {
		return await execute(app, codec, items, options, onProgress);
	} finally {
		activeRun = false;
	}
}

async function execute(
	app: ConversionApp,
	codec: ImageCodec,
	items: ConversionItem[],
	options: ConversionOptions,
	onProgress?: (processed: number, total: number, currentPath: string) => void,
): Promise<ConversionResult> {
	const total = items.length;
	let processed = 0;
	const outcomes = new Array<Outcome | undefined>(total);
	const caseSensitive = options.caseSensitive ?? isCaseSensitiveFileSystem();
	const colliding = collidingTargetPaths(items, options.target, caseSensitive);
	const requestedLimit = options.concurrency ?? DEFAULT_CONVERSION_CONCURRENCY;
	const limit = Math.max(1, Math.min(MAX_CONVERSION_CONCURRENCY, requestedLimit, items.length || 1));
	if (options.signal?.aborted) {
		return {
			converted: [],
			skipped: [],
			failed: [],
			pendingTrash: [],
			savedBytes: 0,
			aborted: true,
			unrestored: [],
		};
	}
	const referenceSnapshot = await readReferenceContentSnapshot(app);
	const referencePaths = [...referenceSnapshot.keys()];
	const statBaseline = noteStatBaseline(app, referencePaths, caseSensitive);
	const vaultPaths = referencePaths;
	const referenceResults = await findImageReferencesBatch(appWithSnapshot(app, referenceSnapshot), items.map((item) => item.path), caseSensitive);
	const sourceLocks = new Map<string, SourceNoteLock>();
	const suspiciousSources = new Set<string>();
	const indexed = items.map((item, index) => ({ item, index }));
	// 与估算一致：解码前按文件体积把大图分到单并发通道，普通图跑满可配置并发。
	const runLane = async (lane: Array<{ item: ConversionItem; index: number }>, concurrency: number) => {
		let next = 0;
		const workers = Array.from({ length: Math.max(1, Math.min(concurrency, lane.length || 1)) }, async () => {
			while (!options.signal?.aborted) {
				const entry = lane[next++];
				if (!entry) return;
				const { item, index } = entry;
				try {
					outcomes[index] = colliding.has(item.path)
						? skip(item.path, 'target-collision', '多张图片会转换为同一目标文件')
						: await convertOne(app, codec, item, options, caseSensitive, referenceResults.get(item.path), sourceLocks, referenceSnapshot, vaultPaths, suspiciousSources, statBaseline, referencePaths);
				} catch (error) {
					outcomes[index] = {
						failed: {
							path: item.path,
							reason: 'write-failed',
							reasonText: `转换失败：${reasonOf(error)}`,
						},
					};
				}
				processed++;
				onProgress?.(processed, total, item.path);
			}
		});
		await Promise.all(workers);
	};
	await Promise.all([
		runLane(indexed.filter((entry) => entry.item.size < LARGE_IMAGE_BYTES), limit),
		runLane(indexed.filter((entry) => entry.item.size >= LARGE_IMAGE_BYTES), 1),
	]);
	for (const item of items) {
		for (const path of indexedInboundSources(app, item.path, caseSensitive)) suspiciousSources.add(path);
	}
	const result: ConversionResult = {
		converted: [],
		skipped: [],
		failed: [],
		pendingTrash: [],
		savedBytes: 0,
		aborted: options.signal?.aborted ?? false,
		unrestored: [],
	};
	for (const outcome of outcomes) {
		if (!outcome) continue;
		if (outcome.converted) {
			result.converted.push(outcome.converted);
			result.savedBytes += outcome.converted.oldBytes - outcome.converted.newBytes;
		}
		if (outcome.skipped) result.skipped.push(outcome.skipped);
		if (outcome.failed) {
			result.failed.push(outcome.failed);
			if (outcome.failed.canRetryTrash && outcome.failed.newPath) {
				result.pendingTrash.push({ path: outcome.failed.path, newPath: outcome.failed.newPath });
			}
		}
		if (outcome.unrestored?.length) result.unrestored.push(...outcome.unrestored);
		if (outcome.keptNewFilePath) {
			result.keptNewFile = true;
			result.keptNewFilePath = outcome.keptNewFilePath;
		}
	}
	result.unrestored = [...new Set(result.unrestored)];
	return result;
}

function collidingTargetPaths(
	items: ConversionItem[],
	target: ImageConvertTarget,
	caseSensitive: boolean,
): Set<string> {
	const groups = new Map<string, string[]>();
	for (const item of items) {
		const key = pathKey(item.targetPath ?? targetPathFor(item.path, target), caseSensitive);
		const group = groups.get(key) ?? [];
		group.push(item.path);
		groups.set(key, group);
	}
	const colliding = new Set<string>();
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		for (const path of group) colliding.add(path);
	}
	return colliding;
}

async function convertOne(
	app: ConversionApp,
	codec: ImageCodec,
	item: ConversionItem,
	options: ConversionOptions,
	caseSensitive: boolean,
	referenceResult: ImageReferenceScanResult | undefined,
	sourceLocks: Map<string, SourceNoteLock>,
	referenceSnapshot: ReferenceContentSnapshot,
	vaultPaths: string[],
	suspiciousSources: Set<string>,
	statBaseline: NoteStatBaseline,
	referencePaths: string[],
): Promise<Outcome> {
	const sourceFile = findFile(app, item.path, caseSensitive);
	if (!sourceFile) {
		return skip(item.path, 'file-missing', '原图已不存在');
	}
	const sourceStat = { size: sourceFile.stat.size, mtime: sourceFile.stat.mtime };
	const format = sourceImageFormat(sourceFile.path);
	if (!format) {
		return skip(sourceFile.path, 'unsupported-codec', '不支持的图片格式');
	}
	if (format === options.target) {
		return skip(item.path, 'same-format', '源格式与目标格式相同');
	}
	const targetPath = item.targetPath ?? targetPathFor(sourceFile.path, options.target);
	if (pathKey(targetPath, caseSensitive) === pathKey(sourceFile.path, caseSensitive)) {
		return skip(item.path, 'same-format', '源格式与目标格式相同');
	}
	const targetFile = findFile(app, targetPath, caseSensitive);
	if (item.size !== sourceStat.size || (item.mtime !== undefined && item.mtime !== sourceStat.mtime)) {
		return skip(item.path, 'file-changed', '原图已变化，请重新扫描');
	}

	let sites: ImageReferenceSite[] | null = null;
	if (!targetFile) {
		if (!referenceResult) {
			const scan = await findImageReferences(app, sourceFile.path, caseSensitive);
			if (!scan.ok) {
				return skip(sourceFile.path, scan.reason, scan.reasonText);
			}
			sites = scan.sites;
		} else if (!referenceResult.ok) {
			return skip(sourceFile.path, referenceResult.reason, referenceResult.reasonText);
		} else {
			sites = referenceResult.sites;
		}
	}
	const bytes = await app.vault.readBinary(sourceFile);
	const current = findFile(app, sourceFile.path, caseSensitive);
	if (!current || current.stat.size !== sourceStat.size
		|| (item.mtime !== undefined && current.stat.mtime !== sourceStat.mtime)) {
		return skip(item.path, 'file-changed', '原图已变化，请重新扫描');
	}

	const decoded = await codec.decode(bytes, { needAlpha: (options.alpha ?? 'flatten') === 'skip' });
	if (!decoded.ok) {
		const reason = decoded.reasonId === 'pixel-limit' ? 'pixel-limit' : 'unsupported-codec';
		return skip(sourceFile.path, reason, decoded.reason);
	}
	const image = decoded.image;
	let encodedBytes: ArrayBuffer;
	try {
		const alpha = options.alpha ?? 'flatten';
		if (alpha === 'skip' && image.hasAlpha) {
			return skip(sourceFile.path, 'alpha-skip', '含透明通道，已按设置跳过');
		}
		const encoded = await codec.encode(image, options.target, {
			quality: options.quality ?? 0.85,
			flatten: options.target === 'jpg' || alpha === 'flatten',
		});
		if (!encoded.ok) {
			return skip(sourceFile.path, 'unsupported-codec', encoded.reason);
		}
		encodedBytes = encoded.bytes;
		// 护栏：转换目的是省空间。若目标格式重编码后体积不减反增（例如高压缩的
		// CAD 线稿 PNG 转 JPG，有损重编码会抵消 PNG 的高压缩比），就保留原图。
		// 判断放在 createBinary 之前：不写新文件、不改写引用、不动原图。
		if (encodedBytes.byteLength >= sourceStat.size) {
			return skip(
				sourceFile.path,
				'larger-than-source',
				`转换为 ${options.target.toUpperCase()} 后体积不减反增（原始 ${formatByteSize(sourceStat.size)}，转换后 ${formatByteSize(encodedBytes.byteLength)}），已保留原图未做转换`,
			);
		}
		if (targetFile) {
			const existingBytes = await app.vault.readBinary(targetFile);
			if (!(await sameBytes(existingBytes, encodedBytes))) {
				return skip(sourceFile.path, 'target-exists', '目标文件已存在且内容不同');
			}
			return retryOrSkipExistingTarget(app, sourceFile, sourceStat, targetFile, caseSensitive, referenceSnapshot, suspiciousSources, statBaseline, referencePaths);
		}
	} finally {
		// 解码出的画布占 宽×高×4 字节；编码结束立刻还回去，避免两个并发
		// worker 的旧画布一直留到 GC。
		codec.release?.(image);
	}
	const referenceSites = sites ?? [];

	let newFile: ConversionFile;
	try {
		newFile = await app.vault.createBinary(targetPath, encodedBytes);
	} catch (error) {
		return {
			failed: {
				path: sourceFile.path,
				reason: 'create-failed',
				reasonText: `创建新文件失败：${reasonOf(error)}`,
			},
		};
	}

	const originals = new Map<string, OriginalContent>();
	try {
		for (const site of referenceSites) {
			await withSourceNoteLock(app, sourceLocks, site.sourcePath, caseSensitive, async (file) => {
				const before = referenceSnapshot.get(file.path) ?? await app.vault.read(file);
				const resolver = makeResolver(app, file.path);
				const analysis = analyzeReferenceContent(
					before,
					sourceFile.path,
					file.path,
					site.sourceKind,
					resolver,
					vaultPaths,
					caseSensitive,
				);
				if (analysis.error || analysis.liveRefs !== site.liveRefs) {
					throw new Error(`${file.path} 的引用在转换期间发生变化`);
				}
				const rewrite = rewriteImageReferences(before, sourceFile.path, targetPath, site.sourceKind, {
					sourcePath: file.path,
					resolveLink: resolver,
					vaultPaths,
					caseSensitive,
				});
				if (rewrite.blockedReason || rewrite.error || rewrite.rewritten !== analysis.liveRefs) {
					throw new Error(rewrite.reasonText ?? rewrite.error ?? `${file.path} 有引用无法改写`);
				}
				await app.vault.process(file, (content) => {
					if (content !== before) throw new Error('文件在转换期间发生变化');
					return rewrite.content;
				});
				referenceSnapshot.set(file.path, rewrite.content);
				originals.set(file.path, { before, after: rewrite.content });
				statBaseline.set(file.path, { size: file.stat.size, mtime: file.stat.mtime });
				await verifyRewrite(app, file, sourceFile.path, targetPath, site.sourceKind, analysis.liveRefs, caseSensitive, referenceSnapshot);
			});
		}
		for (const site of referenceSites) {
			await withSourceNoteLock(app, sourceLocks, site.sourcePath, caseSensitive, async (file) => {
				const content = referenceSnapshot.get(file.path) ?? await app.vault.read(file);
				if (countRemainingReferences(content, sourceFile.path, {
					sourcePath: file.path,
					sourceKind: site.sourceKind,
					caseSensitive,
				}) !== 0) {
					throw new Error(`${file.path} 仍有旧路径引用`);
				}
			});
		}
	} catch (error) {
		return rollbackOutcome(
			app,
			sourceFile.path,
			originals,
			newFile,
			caseSensitive,
			'write-failed',
			`改写引用失败：${reasonOf(error)}`,
			true,
			referenceSnapshot,
			statBaseline,
		);
	}

	const preTrash = await validateBeforeTrash(
		app,
		sourceFile,
		sourceStat,
		sourceFile.path,
		originals,
		newFile,
		caseSensitive,
		referenceSnapshot,
		suspiciousSources,
		statBaseline,
		referencePaths,
	);
	if (preTrash) return preTrash;

	try {
		await app.fileManager.trashFile(sourceFile);
	} catch (error) {
		return {
			failed: {
				path: sourceFile.path,
				newPath: newFile.path,
				reason: 'trash-failed',
				reasonText: `引用已改好，但原图移入回收站失败：${reasonOf(error)}，可重试回收站`,
				canRetryTrash: true,
			},
		};
	}
	return {
		converted: {
			path: sourceFile.path,
			newPath: newFile.path,
			oldBytes: bytes.byteLength,
			newBytes: encodedBytes.byteLength,
		},
	};
}

async function retryOrSkipExistingTarget(
	app: ConversionApp,
	sourceFile: ConversionFile,
	sourceStat: { size: number; mtime: number },
	targetFile: ConversionFile,
	caseSensitive: boolean,
	referenceSnapshot: ReferenceContentSnapshot,
	suspiciousSources: Set<string>,
	statBaseline: NoteStatBaseline,
	referencePaths: string[],
): Promise<Outcome> {
	const oldLive = await countLiveReferencesInVault(app, sourceFile.path);
	if (oldLive !== 0) {
		return skip(sourceFile.path, 'target-exists', '目标文件已存在');
	}
	const newLive = await countLiveReferencesInVault(app, targetFile.path);
	if (newLive === 0) {
		return skip(sourceFile.path, 'target-exists', '目标文件已存在');
	}
	const preTrash = await validateBeforeTrash(
		app,
		sourceFile,
		sourceStat,
		sourceFile.path,
		new Map(),
		null,
		caseSensitive,
		referenceSnapshot,
		suspiciousSources,
		statBaseline,
		referencePaths,
	);
	if (preTrash) return preTrash;
	try {
		await app.fileManager.trashFile(sourceFile);
	} catch (error) {
		return {
			failed: {
				path: sourceFile.path,
				newPath: targetFile.path,
				reason: 'trash-failed',
				reasonText: `引用已指向新文件，但原图移入回收站失败：${reasonOf(error)}，可重试回收站`,
				canRetryTrash: true,
			},
		};
	}
	return {
		converted: {
			path: sourceFile.path,
			newPath: targetFile.path,
			oldBytes: sourceFile.stat.size,
			newBytes: targetFile.stat.size,
		},
	};
}

async function verifyRewrite(
	app: ConversionApp,
	file: ConversionFile,
	oldPath: string,
	newPath: string,
	kind: ImageReferenceSourceKind,
	expectedNewRefs: number,
	caseSensitive: boolean,
	referenceSnapshot: ReferenceContentSnapshot,
): Promise<void> {
	const after = referenceSnapshot.get(file.path) ?? await app.vault.read(file);
	const oldRemaining = countRemainingReferences(after, oldPath, {
		sourcePath: file.path,
		sourceKind: kind,
		caseSensitive,
	});
	if (oldRemaining !== 0) throw new Error(`${file.path} 仍有 ${oldRemaining} 处旧路径引用`);
	const newRefs = countRemainingReferences(after, newPath, {
		sourcePath: file.path,
		sourceKind: kind,
		caseSensitive,
	});
	if (newRefs !== expectedNewRefs) {
		throw new Error(`${file.path} 的新路径引用数量异常（预期 ${expectedNewRefs}，实际 ${newRefs}）`);
	}
}

async function validateBeforeTrash(
	app: ConversionApp,
	sourceFile: ConversionFile,
	expectedStat: { size: number; mtime: number },
	oldPath: string,
	originals: Map<string, OriginalContent>,
	createdFile: ConversionFile | null,
	caseSensitive: boolean,
	referenceSnapshot: ReferenceContentSnapshot,
	suspiciousSources: Set<string>,
	statBaseline: NoteStatBaseline,
	referencePaths: string[],
): Promise<Outcome | null> {
	const current = findFile(app, sourceFile.path, caseSensitive);
	if (!current
		|| current.stat.size !== expectedStat.size
		|| current.stat.mtime !== expectedStat.mtime) {
		return rollbackOutcome(
			app,
			sourceFile.path,
			originals,
			createdFile,
			caseSensitive,
			'source-changed',
			'源图在转换期间发生变化，未移入回收站',
			false,
			referenceSnapshot,
		);
	}
	const rawSources = await findRawImageReferenceSources(app, oldPath, caseSensitive, referenceSnapshot);
	const confirmed = new Set(rawSources);
	const toCheck = new Set(suspiciousSources);
	for (const path of indexedInboundSources(app, oldPath, caseSensitive)) toCheck.add(path);
	for (const path of referencePaths) {
		const file = findFile(app, path, caseSensitive);
		if (!file) continue;
		const baseline = statBaseline.get(file.path);
		if (!baseline || baseline.size !== file.stat.size || baseline.mtime !== file.stat.mtime) toCheck.add(file.path);
	}
	for (const path of toCheck) {
		const file = findFile(app, path, caseSensitive);
		if (!file) continue;
		const content = await app.vault.read(file);
		referenceSnapshot.set(file.path, content);
		statBaseline.set(file.path, { size: file.stat.size, mtime: file.stat.mtime });
		if (hasRawImageReference(content, oldPath, caseSensitive)) confirmed.add(file.path);
	}
	if (confirmed.size > 0) {
		return rollbackOutcome(
			app,
			sourceFile.path,
			originals,
			createdFile,
			caseSensitive,
			'residual-reference',
			`仍可在原始文本中找到旧路径：${[...confirmed].join('、')}`,
			false,
			referenceSnapshot,
			statBaseline,
		);
	}
	return null;
}

async function rollbackOutcome(
	app: ConversionApp,
	sourcePath: string,
	originals: Map<string, OriginalContent>,
	createdFile: ConversionFile | null,
	caseSensitive: boolean,
	reason: string,
	reasonText: string,
	forceFailure = false,
	referenceSnapshot?: ReferenceContentSnapshot,
	statBaseline?: NoteStatBaseline,
): Promise<Outcome> {
	const restored = await restoreOriginals(app, originals, caseSensitive, referenceSnapshot, statBaseline);
	let deleteFailure = '';
	let keptNewFilePath: string | undefined;
	if (createdFile) {
		if (restored.failures.length === 0 && restored.unrestored.length === 0) {
			deleteFailure = await deleteCreatedFile(app, createdFile.path, caseSensitive);
		}
		if (restored.failures.length > 0 || restored.unrestored.length > 0 || deleteFailure) {
			keptNewFilePath = createdFile.path;
		}
	}
	const suffix = [
		restored.failures.length ? `；恢复笔记失败：${restored.failures.join('；')}` : '',
		restored.unrestored.length ? `；以下笔记因并发修改未回滚：${restored.unrestored.join('、')}` : '',
		deleteFailure ? `；删除新文件失败：${deleteFailure}` : '',
		keptNewFilePath ? `；已保留新文件：${keptNewFilePath}` : '',
	].join('');
	if (forceFailure || keptNewFilePath || restored.failures.length > 0 || restored.unrestored.length > 0) {
		return {
			failed: {
				path: sourcePath,
				newPath: keptNewFilePath,
				reason,
				reasonText: `${reasonText}${suffix}`,
			},
			unrestored: restored.unrestored,
			keptNewFilePath,
		};
	}
	return {
		skipped: { path: sourcePath, reason, reasonText: `${reasonText}${suffix}` },
		unrestored: restored.unrestored,
	};
}

async function restoreOriginals(
	app: ConversionApp,
	originals: Map<string, OriginalContent>,
	caseSensitive: boolean,
	referenceSnapshot?: ReferenceContentSnapshot,
	statBaseline?: NoteStatBaseline,
): Promise<RestoreResult> {
	const failures: string[] = [];
	const unrestored: string[] = [];
	for (const [path, original] of originals) {
		const file = findFile(app, path, caseSensitive);
		if (!file) {
			failures.push(`${path} 已不存在`);
			continue;
		}
		const current = await app.vault.read(file);
		if (current !== original.after) {
			unrestored.push(path);
			continue;
		}
		try {
			await app.vault.process(file, () => original.before);
			referenceSnapshot?.set(file.path, original.before);
			statBaseline?.set(file.path, { size: file.stat.size, mtime: file.stat.mtime });
		} catch (error) {
			failures.push(`${path}：${reasonOf(error)}`);
		}
	}
	return { failures, unrestored };
}

async function sameBytes(left: ArrayBuffer, right: ArrayBuffer): Promise<boolean> {
	if (left.byteLength !== right.byteLength) return false;
	const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
	return leftHash !== null && rightHash !== null && leftHash === rightHash;
}

async function sha256(bytes: ArrayBuffer): Promise<string | null> {
	const subtle = typeof crypto === 'undefined' ? null : crypto.subtle;
	if (!subtle) return null;
	try {
		const digest = await subtle.digest('SHA-256', bytes);
		return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	} catch {
		return null;
	}
}

async function deleteCreatedFile(app: ConversionApp, path: string, caseSensitive: boolean): Promise<string> {
	const file = findFile(app, path, caseSensitive);
	if (!file) return '';
	try {
		await app.vault.delete(file);
		return '';
	} catch (error) {
		return reasonOf(error);
	}
}

function makeResolver(app: ConversionApp, sourcePath: string): (linkPath: string) => string | null {
	return (linkPath: string) => app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath)?.path ?? null;
}

async function withSourceNoteLock<T>(
	app: ConversionApp,
	locks: Map<string, SourceNoteLock>,
	path: string,
	caseSensitive: boolean,
	task: (file: ConversionFile) => Promise<T>,
): Promise<T> {
	const key = caseSensitive ? path : pathKey(path, false);
	const lock = locks.get(key) ?? { tail: Promise.resolve() };
	const wait = lock.tail;
	let release!: () => void;
	lock.tail = new Promise<void>((resolve) => { release = resolve; });
	locks.set(key, lock);
	await wait;
	try {
		const file = findFile(app, path, caseSensitive);
		if (!file) throw new Error(`${path} 已不存在`);
		return await task(file);
	} finally {
		release();
	}
}

function findFile(app: ConversionApp, path: string, caseSensitive: boolean): ConversionFile | null {
	const exact = app.vault.getFileByPath(path);
	if (exact) return exact;
	if (caseSensitive) return null;
	const key = pathKey(path, false);
	return app.vault.getFiles().find((file) => pathKey(file.path, false) === key) ?? null;
}

function skip(path: string, reason: string, reasonText: string): Outcome {
	return { skipped: { path, reason, reasonText } };
}

const BYTES_PER_KILOBYTE = 1024;
const BYTES_PER_MEGABYTE = 1024 * 1024;

/** 与界面 formatBytes 同风格的字节格式化，避免 image-convert 层反向依赖 cleanup 层。 */
function formatByteSize(bytes: number): string {
	if (bytes < BYTES_PER_KILOBYTE) return `${bytes} B`;
	if (bytes < BYTES_PER_MEGABYTE) return `${(bytes / BYTES_PER_KILOBYTE).toFixed(1)} KB`;
	return `${(bytes / BYTES_PER_MEGABYTE).toFixed(1)} MB`;
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : '未知错误';
}
