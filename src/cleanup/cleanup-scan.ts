import { App, TFile, TFolder } from 'obsidian';
import { hasHiddenPathSegment, isFrontmatterOnly, isIgnoredPath, needsRawTextSearch, parseExtensions, parseIgnoredFolders, pathLikeTokens, pathTokenCandidates } from '../core-utils';
import { findBrokenImageLinks } from '../broken-image-links';
import { findBrokenNoteLinks } from '../broken-note-links';
import { findNativeImageLinks } from '../native-image-links';
import { findDuplicateFiles } from '../duplicate-files';
import { byPath } from './cleanup-actions';
import { COMMON_IMAGE_EXTENSIONS, type CleanupCandidates, type ScanCategoryTab, type ScanProgress } from './cleanup-types';

const READ_CONCURRENCY = 8;

export async function forEachWithConcurrency<T>(items: T[], concurrency: number, visit: (item: T, index: number) => Promise<void>): Promise<void> {
	const limit = Math.max(1, Math.min(concurrency, items.length || 1));
	let next = 0;
	let failure: unknown;
	let aborted = false;
	const workers = Array.from({ length: limit }, async () => {
		while (!aborted) {
			const index = next++;
			if (index >= items.length) return;
			try {
				await visit(items[index] as T, index);
			} catch (error) {
				// Stop handing out work, but let the visits already running settle so
				// no scan keeps touching the vault after the caller sees the rejection.
				if (!aborted) {
					aborted = true;
					failure = error;
				}
				return;
			}
		}
	});
	await Promise.all(workers);
	if (aborted) throw failure;
}
export async function findCleanupCandidates(app: App, imageExtensions: string, ignoredFoldersValue = '', onProgress?: (progress: ScanProgress) => void, checkLinksAndDuplicates = true, onCategoryComplete?: (tabs: ScanCategoryTab[], results: Partial<CleanupCandidates>) => void): Promise<CleanupCandidates> {
	const extensions = parseExtensions(imageExtensions);
	const ignoredFolders = parseIgnoredFolders(ignoredFoldersValue);
	const visibleFiles = app.vault.getFiles().filter((file) => !hasHiddenPathSegment(file.path) && !isIgnoredPath(file.path, ignoredFolders));
	onProgress?.({ stage: 0, processed: visibleFiles.length, total: visibleFiles.length, currentFile: visibleFiles.at(-1)?.path });
	const attachmentFiles = visibleFiles.filter((file) => !['md', 'canvas'].includes(file.extension.toLowerCase()));
	const images = attachmentFiles.filter((file) => extensions.has(file.extension.toLowerCase()));
	const attachments = attachmentFiles.filter((file) => !extensions.has(file.extension.toLowerCase()));
	const referenced = new Set<string>();
	for (const [sourcePath, destinations] of Object.entries(app.metadataCache.resolvedLinks)) {
		if (!sourcePath.toLowerCase().endsWith('.md')) continue;
		for (const path of Object.keys(destinations)) referenced.add(path);
	}
	const canvases = app.vault.getFiles().filter((file) => file.extension.toLowerCase() === 'canvas');
	for (const [index, canvas] of canvases.entries()) {
		for (const path of await referencedByCanvas(app, canvas)) referenced.add(path);
		onProgress?.({ stage: 1, processed: index + 1, total: canvases.length || 1, currentFile: canvas.path });
	}
	onProgress?.({ stage: 2, processed: 0, total: app.vault.getMarkdownFiles().length });
	// Conservative textual pass: HTML image tags, frontmatter path values, and
	// code-block text do not appear in resolvedLinks. Any textual mention of the
	// file name or path counts as a reference so that such images are never
	// flagged as orphans.
	await markFilesReferencedByText(app, [...images, ...attachments], referenced, (processed, total, currentFile) => onProgress?.({ stage: 2, processed, total, currentFile }));
	onCategoryComplete?.(['images', 'attachments'], {
		images: images.filter((file) => !referenced.has(file.path)).sort(byPath),
		attachments: attachments.filter((file) => !referenced.has(file.path)).sort(byPath),
	});
	const emptyFiles = (await findEmptyFiles(visibleFiles, extensions, app, (processed, total, currentFile) => onProgress?.({ stage: 3, processed, total, currentFile }))).filter((file) => !referenced.has(file.path));
	const folders = findRecursivelyEmptyFolders(app.vault.getRoot(), ignoredFolders).sort((a, b) => b.path.length - a.path.length || byPath(a, b));
	onProgress?.({ stage: 3, processed: visibleFiles.length, total: visibleFiles.length, currentFile: visibleFiles.at(-1)?.path });
	onCategoryComplete?.(['empty-files', 'folders'], { emptyFiles, folders });
	onProgress?.({ stage: 4, processed: 0, total: 1 });
	const brokenLinks = checkLinksAndDuplicates ? findBrokenImageLinks(app, imageExtensions) : [];
	const nativeLinks = checkLinksAndDuplicates ? findNativeImageLinks(app, imageExtensions) : [];
	const brokenNoteLinks = checkLinksAndDuplicates ? findBrokenNoteLinks(app, imageExtensions) : [];
	onCategoryComplete?.(['broken-links', 'native-links', 'broken-note-links'], { brokenLinks, nativeLinks, brokenNoteLinks });
	onProgress?.({ stage: 5, processed: 0, total: 1 });
	const duplicateResult = checkLinksAndDuplicates ? await findDuplicateFiles(app, ignoredFoldersValue, (progress) => onProgress?.({ stage: 5, ...progress })) : { groups: [], warnings: [] };
	onCategoryComplete?.(['duplicates'], { duplicates: duplicateResult.groups, duplicateWarnings: duplicateResult.warnings });
	return {
		images: images.filter((file) => !referenced.has(file.path)).sort(byPath),
		attachments: attachments.filter((file) => !referenced.has(file.path)).sort(byPath),
		emptyFiles,
		folders,
		brokenLinks,
		nativeLinks,
		brokenNoteLinks,
		duplicates: duplicateResult.groups,
		duplicateWarnings: duplicateResult.warnings,
	};
}

export async function findEmptyFiles(files: TFile[], imageExtensions: Set<string>, app: App, onProgress?: (processed: number, total: number, currentFile: string) => void): Promise<TFile[]> {
	const result: TFile[] = [];
	let processed = 0;
	await forEachWithConcurrency(files, READ_CONCURRENCY, async (file) => {
		processed += 1;
		onProgress?.(processed, files.length, file.path);
		const extension = file.extension.toLowerCase();
		if (extension === 'canvas') return;
		if (file.stat.size === 0 && !imageExtensions.has(extension) && !COMMON_IMAGE_EXTENSIONS.has(extension)) { result.push(file); return; }
		if (extension !== 'md') return;
		const content = await app.vault.cachedRead(file);
		if (isFrontmatterOnly(content)) result.push(file);
	});
	return result.sort(byPath);
}

export async function markFilesReferencedByText(app: App, images: TFile[], referenced: Set<string>, onProgress?: (processed: number, total: number, currentFile: string) => void): Promise<void> {
	const remaining = images.filter((image) => !referenced.has(image.path));
	if (remaining.length === 0) return;
	const unresolved = new Set(remaining.map((image) => image.path));
	const markReferenced = (path: string) => {
		referenced.add(path);
		unresolved.delete(path);
	};
	const byBasename = new Map<string, string[]>();
	const byPath = new Map<string, string>();
	const exoticNames: string[] = [];
	for (const image of remaining) {
		const key = image.name.toLowerCase();
		const paths = byBasename.get(key) ?? [];
		paths.push(image.path);
		byBasename.set(key, paths);
		byPath.set(image.path.toLowerCase(), image.path);
		if (needsRawTextSearch(image.name)) exoticNames.push(key);
	}
	const markdownFiles = app.vault.getMarkdownFiles();
	const BATCH = READ_CONCURRENCY * 4;
	for (let start = 0; start < markdownFiles.length; start += BATCH) {
		const batch = markdownFiles.slice(start, start + BATCH);
		const contents = await Promise.all(batch.map((file) => app.vault.cachedRead(file)));
		for (const [offset, content] of contents.entries()) {
			const file = batch[offset]!;
			onProgress?.(start + offset + 1, markdownFiles.length, file.path);
			for (const token of pathLikeTokens(content)) {
				for (const candidate of pathTokenCandidates(token.replace(/^[./\\]+/, ''))) {
					for (const variant of [candidate, safeDecodePath(candidate)]) {
						const direct = byPath.get(variant.toLowerCase());
						if (direct) markReferenced(direct);
						for (const path of byBasename.get(lastPathSegment(variant).toLowerCase()) ?? []) markReferenced(path);
					}
				}
			}
			if (exoticNames.length) {
				// Lowercase once per note instead of once per exotic file name.
				const lowered = content.toLowerCase();
				for (let index = exoticNames.length - 1; index >= 0; index--) {
					const key = exoticNames[index]!;
					if (!lowered.includes(key)) continue;
					for (const path of byBasename.get(key) ?? []) markReferenced(path);
					exoticNames.splice(index, 1);
				}
			}
			if (unresolved.size === 0) return;
		}
	}
}

export async function referencedByCanvas(app: App, canvas: TFile): Promise<string[]> {
	try {
		const content = JSON.parse(await app.vault.read(canvas)) as { nodes?: Array<{ file?: unknown }> };
		return (content.nodes ?? []).flatMap((node) => {
			if (typeof node.file !== 'string') return [];
			const file = app.metadataCache.getFirstLinkpathDest(node.file, canvas.path);
			return file instanceof TFile ? [file.path] : [];
		});
	} catch {
		return [];
	}
}

export function findRecursivelyEmptyFolders(folder: TFolder, ignoredFolders: string[] = []): TFolder[] {
	const candidates: TFolder[] = [];
	const visit = (current: TFolder): boolean => {
		// Hidden folders such as .obsidian, .trash, and .git are system folders:
		// never candidates, and they block their parent from being listed as empty.
		if (hasHiddenPathSegment(current.path)) return false;
		if (isIgnoredPath(current.path, ignoredFolders)) return false;
		let onlyEmptyFolders = true;
		for (const child of current.children) {
			if (child instanceof TFolder) {
				if (!visit(child)) onlyEmptyFolders = false;
			} else {
				onlyEmptyFolders = false;
			}
		}
		if (onlyEmptyFolders && current.path) candidates.push(current);
		return onlyEmptyFolders;
	};
	visit(folder);
	return candidates;
}

function lastPathSegment(path: string) {
	const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return index >= 0 ? path.slice(index + 1) : path;
}

function safeDecodePath(path: string) {
	try { return decodeURIComponent(path); } catch { return path; }
}
