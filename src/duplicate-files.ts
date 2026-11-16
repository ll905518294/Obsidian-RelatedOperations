import type { App, TAbstractFile, TFile } from 'obsidian';
import { errorMessage, forEachWithConcurrency, hasHiddenPathSegment, isIgnoredPath, parseIgnoredFolders } from './core-utils.ts';
import { CleanupScanAbortedError } from './cleanup/cleanup-types.ts';

const HASH_CONCURRENCY = 8;
// `readBinary` 只能整份读入；8 路并发遇到 100MB 视频就是 800MB。
// 用最大候选文件的体积把“文件体积 × 并发”压在约 64MB 以内，小文件仍跑满 8 路。
const HASH_BYTE_BUDGET = 64 * 1024 * 1024;

type HashResult = { ok: true; hash: string } | { ok: false; error: unknown };

export interface DuplicateFileItem {
	path: string;
	extension: string;
	size: number;
	mtime: number;
	referenced: boolean;
	referencingNotes: string[];
}

export interface DuplicateFileGroup {
	hash: string;
	size: number;
	files: DuplicateFileItem[];
}

export interface DuplicateScanProgress {
	processed: number;
	total: number;
	currentFile?: string;
}

export interface DuplicateScanResult {
	groups: DuplicateFileGroup[];
	warnings: Array<{ path: string; reason: string }>;
}

export interface DuplicateDeletionPlan {
	deletable: DuplicateFileItem[];
	skipped: Array<{ path: string; reason: string }>;
	// 计划阶段校验通过的字节指纹；引用清理等操作会耗时，删除前据此复检。
	verified: Array<{ path: string; size: number; digest: string }>;
}

export async function findDuplicateFiles(
	app: App,
	ignoredFoldersValue = '',
	onProgress?: (progress: DuplicateScanProgress) => void,
	signal?: AbortSignal,
): Promise<DuplicateScanResult> {
	const ignoredFolders = parseIgnoredFolders(ignoredFoldersValue);
	const files = app.vault.getFiles().filter((file) =>
		file.extension.toLowerCase() !== 'canvas' &&
		!hasHiddenPathSegment(file.path) &&
		!isIgnoredPath(file.path, ignoredFolders),
	);
	const referenced = new Set<string>();
	const referencingByPath = new Map<string, Set<string>>();
	for (const [source, destinations] of Object.entries(app.metadataCache.resolvedLinks)) {
		for (const path of Object.keys(destinations)) {
			referenced.add(path);
			const sources = referencingByPath.get(path) ?? new Set<string>();
			sources.add(source);
			referencingByPath.set(path, sources);
		}
	}
	const bySize = new Map<number, TFile[]>();
	const snapshot = new Map<TFile, { size: number; mtime: number }>();
	for (const file of files) {
		snapshot.set(file, { size: file.stat.size, mtime: file.stat.mtime });
		const group = bySize.get(file.stat.size) ?? [];
		group.push(file);
		bySize.set(file.stat.size, group);
	}
	const hashGroups = new Map<string, DuplicateFileItem[]>();
	const warnings: Array<{ path: string; reason: string }> = [];
	const candidates = [...bySize.values()].filter((group) => group.length > 1).flat();
	// 并发读取哈希，但按原始顺序回收结果与告警，保证输出稳定。
	const hashes: Array<HashResult | undefined> = new Array<HashResult | undefined>(candidates.length);
	const stillPresent = createPresenceChecker(app);
	let processed = 0;
	await forEachWithConcurrency(candidates, hashConcurrency(candidates), async (file, index) => {
		// 校验和是重复文件阶段最重的工作；中止后不再领取新文件。
		if (signal?.aborted) throw new CleanupScanAbortedError();
		try {
			hashes[index] = { ok: true, hash: await digestFile(app, file) };
		} catch (error) {
			hashes[index] = { ok: false, error };
		}
		processed += 1;
		onProgress?.({ processed, total: candidates.length, currentFile: file.path });
	});
	for (const [index, file] of candidates.entries()) {
		const result = hashes[index];
		if (!result) continue;
		// 文件在扫描期间被删除或改名后，旧路径不再是候选；改名会更新同一个
		// TFile 的 path，因此仍然按当前路径收录。
		if (!stillPresent(file)) continue;
		const before = snapshot.get(file)!;
		if (file.stat.size !== before.size || file.stat.mtime !== before.mtime) {
			warnings.push({ path: file.path, reason: '文件内容已变化，请重新扫描' });
			continue;
		}
		if (!result.ok) {
			warnings.push({ path: file.path, reason: errorMessage(result.error, '无法读取文件内容') });
			continue;
		}
		const key = `${file.stat.size}:${result.hash}`;
		const items = hashGroups.get(key) ?? [];
		items.push({ path: file.path, extension: file.extension, size: file.stat.size, mtime: file.stat.mtime, referenced: referenced.has(file.path), referencingNotes: [...(referencingByPath.get(file.path) ?? [])].sort((a, b) => a.localeCompare(b)) });
		hashGroups.set(key, items);
	}
	return {
		groups: [...hashGroups.entries()]
			.filter(([, files]) => files.length > 1)
			.map(([key, files]) => ({ hash: key.slice(key.indexOf(':') + 1), size: files[0]!.size, files: files.sort((a, b) => a.path.localeCompare(b.path)) }))
			.sort((a, b) => a.files[0]!.path.localeCompare(b.files[0]!.path)),
		warnings,
	};
}

function hashConcurrency(candidates: TFile[]): number {
	return byteBudgetConcurrency(candidates.map((file) => file.stat.size));
}

function byteBudgetConcurrency(sizes: Iterable<number>): number {
	let largest = 0;
	for (const size of sizes) largest = Math.max(largest, size);
	if (largest <= 0) return HASH_CONCURRENCY;
	return Math.max(1, Math.min(HASH_CONCURRENCY, Math.floor(HASH_BYTE_BUDGET / largest)));
}

function createPresenceChecker(app: App): (file: TFile) => boolean {
	if (typeof app.vault.getAbstractFileByPath !== 'function') return () => true;
	// 宿主索引与 getFiles 短暂不一致时，只要文件仍在列表里就保留。
	// 集合惰性构建并复用，避免每个候选都全量遍历（同尺寸文件多时是平方级）。
	let listed: Set<TAbstractFile> | undefined;
	return (file) => {
		const current = app.vault.getAbstractFileByPath(file.path);
		if (current === file) return true;
		if (current) return false;
		listed ??= new Set(app.vault.getFiles());
		return listed.has(file);
	};
}

export async function removeFileReferencesForFiles(app: App, filePaths: Iterable<string>): Promise<{ removed: number; failed: string[] }> {
	const targets = new Set(filePaths);
	let removed = 0;
	const failed: string[] = [];
	for (const source of app.vault.getMarkdownFiles()) {
		// 源笔记本身就在删除列表里时，清理它的引用没有意义；更关键的是，
		// 改写会让它不再等于扫描时的重复内容，破坏“按旧哈希删除”的前提。
		if (targets.has(source.path)) continue;
		const cache = app.metadataCache.getFileCache(source);
		const references: Array<{ original: string; link: string; position: { start: { offset: number }; end: { offset: number } } }> = [];
		const matched = new Map<string, number>();
		for (const reference of [...cache?.embeds ?? [], ...cache?.links ?? []]) {
			const target = app.metadataCache.getFirstLinkpathDest(reference.link.split('#', 1)[0] ?? '', source.path);
			if (!target || !targets.has(target.path)) continue;
			references.push(reference);
			matched.set(target.path, (matched.get(target.path) ?? 0) + 1);
		}
		const unresolved = countUnresolvedReferences(app, source.path, targets, matched);
		if (unresolved) {
			// Obsidian resolved a link we could not locate in the cache (stale or
			// unloaded cache, unusual link syntax); deleting now could leave a link
			// pointing at a removed file, so the whole batch is refused.
			failed.push(`${source.path}（${unresolved} 处引用无法定位，已跳过删除）`);
			continue;
		}
		if (!references.length) continue;
		try {
			await app.vault.process(source, (content) => {
				let updated = content;
				let localRemoved = 0;
				for (const reference of [...references].sort((a, b) => b.position.start.offset - a.position.start.offset)) {
					const range = referenceRange(updated, reference);
					if (!range) continue;
					updated = updated.slice(0, range.start) + updated.slice(range.end);
					localRemoved++;
				}
				const remaining = references.find((reference) => updated.includes(reference.original));
				if (remaining) {
					// Deleting the target now would leave a live reference behind; the
					// caller aborts when any source is reported as failed.
					failed.push(`${source.path}（仍有对 ${remaining.link} 的引用，已跳过删除）`);
					return content;
				}
				removed += localRemoved;
				return updated;
			});
		} catch (error) {
			failed.push(`${source.path}（${errorMessage(error)}）`);
		}
	}
	return { removed, failed };
}

// `resolvedLinks` is Obsidian's own resolution of every link in the note. If it
// counts more links to a target than the metadata cache exposes, the removal
// pass cannot rewrite them all and the caller must not delete anything.
function countUnresolvedReferences(app: App, sourcePath: string, targets: Set<string>, matched: Map<string, number>): number {
	const resolved = app.metadataCache.resolvedLinks?.[sourcePath];
	if (!resolved) return 0;
	let unresolved = 0;
	for (const [path, count] of Object.entries(resolved)) {
		if (!targets.has(path) || typeof count !== 'number') continue;
		unresolved += Math.max(0, count - (matched.get(path) ?? 0));
	}
	return unresolved;
}

export async function removeImageReferencesForFile(app: App, filePath: string): Promise<{ removed: number; failed: string[] }> {
	return removeFileReferencesForFiles(app, [filePath]);
}

/**
 * Re-checks the selected duplicate files right before deletion.
 *
 * Two guarantees:
 * - When part of a group is selected, each selected file must still match an
 *   unselected copy in the same group.
 * - When every file of a group is selected, the selected files must still
 *   match each other, so deleting the whole group only removes one logical
 *   copy of the content.
 * Files whose bytes changed after the scan are skipped instead of deleted.
 */
export async function planDuplicateDeletion(
	app: App,
	groups: DuplicateFileGroup[],
	selectedPaths: Iterable<string>,
): Promise<DuplicateDeletionPlan> {
	const selected = new Set(selectedPaths);
	const known = new Set<string>();
	const deletable: DuplicateFileItem[] = [];
	const skipped: Array<{ path: string; reason: string }> = [];
	const verified: Array<{ path: string; size: number; digest: string }> = [];
	for (const group of groups) {
		for (const file of group.files) known.add(file.path);
		const candidates = group.files.filter((file) => selected.has(file.path));
		if (candidates.length === 0) continue;
		const keepers = group.files.filter((file) => !selected.has(file.path));
		let keeperHash: string;
		let keeperSize: number;
		try {
			// With the whole group selected there is no keeper to compare
			// against, so the first selected file becomes the reference copy.
			const reference = keepers[0] ?? candidates[0]!;
			const bytes = await app.vault.readBinary(resolveFile(app, reference.path));
			keeperSize = bytes.byteLength;
			keeperHash = await digestBytes(bytes);
		} catch (error) {
			for (const file of candidates) skipped.push({ path: file.path, reason: keepers.length ? `无法读取保留文件：${errorMessage(error)}` : `无法读取参照文件：${errorMessage(error)}` });
			continue;
		}
		for (const file of candidates) {
			try {
				const bytes = await app.vault.readBinary(resolveFile(app, file.path));
				const digest = await digestBytes(bytes);
				if (bytes.byteLength !== keeperSize || digest !== keeperHash) {
					skipped.push({ path: file.path, reason: '文件内容已变化，请重新扫描' });
					continue;
				}
				deletable.push(file);
				verified.push({ path: file.path, size: bytes.byteLength, digest });
			} catch (error) {
				skipped.push({ path: file.path, reason: errorMessage(error) });
			}
		}
	}
	for (const path of selected) {
		if (!known.has(path)) skipped.push({ path, reason: '重复分组已变化，请重新扫描' });
	}
	return { deletable, skipped, verified };
}

/**
 * Re-reads planned files right before deletion and reports any whose bytes no
 * longer match what the plan verified. Files removed or unreadable in the
 * meantime are skipped with the same reason users see after a rescan.
 */
export async function revalidateDuplicateDeletion(
	app: App,
	planned: Iterable<{ path: string; size: number; digest: string }>,
): Promise<Array<{ path: string; reason: string }>> {
	const items = [...planned];
	const skipped = new Array<{ path: string; reason: string } | undefined>(items.length);
	await forEachWithConcurrency(items, byteBudgetConcurrency(items.map((item) => item.size)), async (item, index) => {
		try {
			const bytes = await app.vault.readBinary(resolveFile(app, item.path));
			if (bytes.byteLength !== item.size || await digestBytes(bytes) !== item.digest) {
				skipped[index] = { path: item.path, reason: '文件内容已变化，请重新扫描' };
			}
		} catch (error) {
			skipped[index] = { path: item.path, reason: errorMessage(error) };
		}
	});
	return skipped.filter((item): item is { path: string; reason: string } => !!item);
}

function referenceRange(
	content: string,
	reference: { original: string; position: { start: { offset: number }; end: { offset: number } } },
) {
	const start = reference.position.start.offset;
	const end = reference.position.end.offset;
	if (start >= 0 && end > start && end <= content.length && content.slice(start, end) === reference.original) {
		return { start, end };
	}
	const found = content.indexOf(reference.original);
	return found < 0 ? null : { start: found, end: found + reference.original.length };
}

async function digestFile(app: App, file: TFile): Promise<string> {
	return digestBytes(await app.vault.readBinary(file));
}

// 每个候选文件都要把 32 字节摘要转成十六进制。原先的
// `[...bytes].map(...).join('')` 会为每个文件分配 32 个子串和 1 个数组；
// 同尺寸候选多时这些短命对象会直接抬高扫描峰值。
const HEX_BYTES = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));

async function digestBytes(bytes: ArrayBuffer): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	let hex = '';
	for (const byte of digest) hex += HEX_BYTES[byte]!;
	return hex;
}

function resolveFile(app: App, path: string): TFile {
	const target = app.vault.getAbstractFileByPath(path);
	if (!isFileLike(target)) throw new Error('文件已不存在');
	return target;
}

// `obsidian` ships type declarations only (its package has no runtime entry),
// and this module is loaded directly by the native node tests, so a runtime
// `instanceof TFile` import is impossible here. Structurally: `TFile` is the
// only `TAbstractFile` subclass exposing `extension`, while `TFolder` exposes
// `children` instead. The predicate narrows the call site without a cast.
function isFileLike(target: TAbstractFile | null): target is TFile {
	return !!target && !('children' in target) && 'extension' in target;
}

