import type { App, TFile } from 'obsidian';
import { hasHiddenPathSegment, isIgnoredPath, parseIgnoredFolders } from './core-utils.ts';

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

export async function findDuplicateFiles(
	app: App,
	ignoredFoldersValue = '',
	onProgress?: (progress: DuplicateScanProgress) => void,
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
	for (const file of files) {
		const group = bySize.get(file.stat.size) ?? [];
		group.push(file);
		bySize.set(file.stat.size, group);
	}
	const hashGroups = new Map<string, DuplicateFileItem[]>();
	const warnings: Array<{ path: string; reason: string }> = [];
	const candidates = [...bySize.values()].filter((group) => group.length > 1).flat();
	for (const [index, file] of candidates.entries()) {
		onProgress?.({ processed: index + 1, total: candidates.length, currentFile: file.path });
		try {
			const hash = await digestFile(app, file);
			const key = `${file.stat.size}:${hash}`;
			const items = hashGroups.get(key) ?? [];
			items.push({ path: file.path, extension: file.extension, size: file.stat.size, mtime: file.stat.mtime, referenced: referenced.has(file.path), referencingNotes: [...(referencingByPath.get(file.path) ?? [])].sort((a, b) => a.localeCompare(b)) });
			hashGroups.set(key, items);
		} catch (error) {
			warnings.push({ path: file.path, reason: error instanceof Error ? error.message : '无法读取文件内容' });
		}
	}
	return {
		groups: [...hashGroups.entries()]
			.filter(([, files]) => files.length > 1)
			.map(([key, files]) => ({ hash: key.slice(key.indexOf(':') + 1), size: files[0]!.size, files: files.sort((a, b) => a.path.localeCompare(b.path)) }))
			.sort((a, b) => a.files[0]!.path.localeCompare(b.files[0]!.path)),
		warnings,
	};
}

export async function removeFileReferencesForFiles(app: App, filePaths: Iterable<string>): Promise<{ removed: number; failed: string[] }> {
	const targets = new Set(filePaths);
	let removed = 0;
	const failed: string[] = [];
	for (const source of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(source);
		const references = [...cache?.embeds ?? [], ...cache?.links ?? []].filter((reference) => {
			const target = app.metadataCache.getFirstLinkpathDest(reference.link.split('#', 1)[0] ?? '', source.path);
			return target && targets.has(target.path);
		});
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
			failed.push(`${source.path}（${error instanceof Error ? error.message : '未知错误'}）`);
		}
	}
	return { removed, failed };
}

export async function removeImageReferencesForFile(app: App, filePath: string) {
	return removeFileReferencesForFiles(app, [filePath]);
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
	const digest = await crypto.subtle.digest('SHA-256', await app.vault.readBinary(file));
	return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
