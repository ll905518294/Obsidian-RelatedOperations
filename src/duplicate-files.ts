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
	for (const destinations of Object.values(app.metadataCache.resolvedLinks)) {
		for (const path of Object.keys(destinations)) referenced.add(path);
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
			items.push({ path: file.path, extension: file.extension, size: file.stat.size, mtime: file.stat.mtime, referenced: referenced.has(file.path), referencingNotes: referencingNotesFor(file.path, app) });
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

export async function removeImageReferencesForFile(app: App, filePath: string): Promise<{ removed: number; failed: string[] }> {
	let removed = 0;
	const failed: string[] = [];
	for (const source of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(source);
		const references = [...cache?.embeds ?? [], ...cache?.links ?? []].filter((reference) => {
			if (!reference.original.startsWith('!')) return false;
			const target = app.metadataCache.getFirstLinkpathDest(reference.link.split('#', 1)[0] ?? '', source.path);
			return target?.path === filePath;
		});
		if (!references.length) continue;
		try {
			await app.vault.process(source, (content) => {
				for (const reference of [...references].sort((a, b) => b.position.start.offset - a.position.start.offset)) {
					const start = reference.position.start.offset;
					const end = reference.position.end.offset;
					if (content.slice(start, end) !== reference.original) continue;
					content = content.slice(0, start) + content.slice(end);
					removed++;
				}
				return content;
			});
		} catch (error) {
			failed.push(`${source.path}（${error instanceof Error ? error.message : '未知错误'}）`);
		}
	}
	return { removed, failed };
}

function referencingNotesFor(path: string, app: App): string[] {
	return Object.entries(app.metadataCache.resolvedLinks)
		.filter(([, destinations]) => Object.prototype.hasOwnProperty.call(destinations, path))
		.map(([source]) => source)
		.sort((a, b) => a.localeCompare(b));
}

async function digestFile(app: App, file: TFile): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', await app.vault.readBinary(file));
	return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
