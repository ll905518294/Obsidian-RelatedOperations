import type { CachedMetadata } from 'obsidian';
import { isCaseSensitiveFileSystem } from '../core-utils.ts';
import type { ImageCodec } from './image-codec.ts';
import type { ImageConvertTarget } from './image-convert-plan.ts';
import { pathKey, sourceImageFormat, targetPathFor } from './image-convert-plan.ts';
import {
	analyzeReferenceContent,
	countLiveReferencesInVault,
	countRemainingReferences,
	findImageReferences,
	findRawImageReferenceSources,
	rewriteImageReferences,
	type ImageReferenceSite,
	type ImageReferenceSourceKind,
} from './image-convert-links.ts';

export interface ConversionFile {
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

export interface ConversionItem {
	path: string;
	size: number;
	mtime?: number;
	targetPath?: string;
}

export interface ConversionOptions {
	target: ImageConvertTarget;
	quality?: number;
	signal?: AbortSignal;
	caseSensitive?: boolean;
	alpha?: 'flatten' | 'skip';
}

export interface ConvertedImage {
	path: string;
	newPath: string;
	oldBytes: number;
	newBytes: number;
}

export interface ConversionSkip {
	path: string;
	reason: string;
	reasonText: string;
}

export interface ConversionFailure extends ConversionSkip {
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

export const runImageConversions = runImageConversion;

async function execute(
	app: ConversionApp,
	codec: ImageCodec,
	items: ConversionItem[],
	options: ConversionOptions,
	onProgress?: (processed: number, total: number, currentPath: string) => void,
): Promise<ConversionResult> {
	const total = items.length;
	let processed = 0;
	let next = 0;
	const outcomes = new Array<Outcome | undefined>(total);
	const caseSensitive = options.caseSensitive ?? isCaseSensitiveFileSystem();
	const colliding = collidingTargetPaths(items, options.target, caseSensitive);
	const limit = Math.min(2, items.length || 1);
	const workers = Array.from({ length: limit }, async () => {
		while (!options.signal?.aborted) {
			const index = next++;
			if (index >= total) return;
			const item = items[index]!;
			try {
				outcomes[index] = colliding.has(item.path)
					? skip(item.path, 'target-collision', '多张图片会转换为同一目标文件')
					: await convertOne(app, codec, item, options, caseSensitive);
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
		const scan = await findImageReferences(app, sourceFile.path, caseSensitive);
		if (!scan.ok) {
			return skip(sourceFile.path, scan.reason, scan.reasonText);
		}
		sites = scan.sites;
	}
	const bytes = await app.vault.readBinary(sourceFile);
	const current = findFile(app, sourceFile.path, caseSensitive);
	if (!current || current.stat.size !== sourceStat.size
		|| (item.mtime !== undefined && current.stat.mtime !== sourceStat.mtime)) {
		return skip(item.path, 'file-changed', '原图已变化，请重新扫描');
	}

	const decoded = await codec.decode(bytes);
	if (!decoded.ok) {
		return skip(sourceFile.path, 'unsupported-codec', decoded.reason);
	}
	const alpha = options.alpha ?? 'flatten';
	if (alpha === 'skip' && decoded.image.hasAlpha) {
		return skip(sourceFile.path, 'alpha-skip', '含透明通道，已按设置跳过');
	}
	const encoded = await codec.encode(decoded.image, options.target, {
		quality: options.quality ?? 0.85,
		flatten: options.target === 'jpg' || alpha === 'flatten',
	});
	if (!encoded.ok) {
		return skip(sourceFile.path, 'unsupported-codec', encoded.reason);
	}
	if (targetFile) {
		const existingBytes = await app.vault.readBinary(targetFile);
		if (!(await sameBytes(existingBytes, encoded.bytes))) {
			return skip(sourceFile.path, 'target-exists', '目标文件已存在且内容不同');
		}
		return retryOrSkipExistingTarget(app, sourceFile, sourceStat, targetFile, caseSensitive);
	}
	const referenceSites = sites ?? [];

	let newFile: ConversionFile;
	try {
		newFile = await app.vault.createBinary(targetPath, encoded.bytes);
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
			const file = findFile(app, site.sourcePath, caseSensitive);
			if (!file) throw new Error(`${site.sourcePath} 已不存在`);
			const before = await app.vault.read(file);
			const resolver = makeResolver(app, file.path);
			const vaultPaths = app.vault.getFiles().map((candidate) => candidate.path);
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
			originals.set(file.path, { before, after: rewrite.content });
			await verifyRewrite(app, file, sourceFile.path, targetPath, site.sourceKind, analysis.liveRefs, caseSensitive);
		}
		for (const site of referenceSites) {
			const file = findFile(app, site.sourcePath, caseSensitive);
			if (!file) throw new Error(`${site.sourcePath} 已不存在`);
			const content = await app.vault.read(file);
			if (countRemainingReferences(content, sourceFile.path, {
				sourcePath: file.path,
				sourceKind: site.sourceKind,
				caseSensitive,
			}) !== 0) {
				throw new Error(`${file.path} 仍有旧路径引用`);
			}
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
			newBytes: encoded.bytes.byteLength,
		},
	};
}

async function retryOrSkipExistingTarget(
	app: ConversionApp,
	sourceFile: ConversionFile,
	sourceStat: { size: number; mtime: number },
	targetFile: ConversionFile,
	caseSensitive: boolean,
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
): Promise<void> {
	const after = await app.vault.read(file);
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
		);
	}
	const rawSources = await findRawImageReferenceSources(app, oldPath, caseSensitive);
	if (rawSources.length > 0) {
		return rollbackOutcome(
			app,
			sourceFile.path,
			originals,
			createdFile,
			caseSensitive,
			'residual-reference',
			`仍可在原始文本中找到旧路径：${rawSources.join('、')}`,
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
): Promise<Outcome> {
	const restored = await restoreOriginals(app, originals, caseSensitive);
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

function makeResolver(app: ConversionApp, sourcePath: string) {
	return (linkPath: string) => app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath)?.path ?? null;
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

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : '未知错误';
}
