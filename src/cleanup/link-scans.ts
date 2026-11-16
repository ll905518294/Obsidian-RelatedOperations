import type { App, TFile } from 'obsidian';
import { collectBrokenImageLinks, type BrokenImageLink } from '../broken-image-links';
import { collectBrokenNoteLinks, type BrokenNoteLink } from '../broken-note-links';
import { collectNativeImageLinks, nativeImageExtensionSet, type NativeImageLink } from '../native-image-links';
import { collectWikiNoteLinks, type WikiNoteLink } from '../wiki-note-links';
import { parseExtensions } from '../core-utils';

export interface VaultLinkScans {
	brokenLinks: BrokenImageLink[];
	nativeLinks: NativeImageLink[];
	brokenNoteLinks: BrokenNoteLink[];
	wikiLinks: WikiNoteLink[];
}

interface PositionedLink {
	sourcePath: string;
	position: { start: { offset: number } };
}

/*
 * 四类链接扫描原本各自遍历一遍 Markdown 文件并各自查一次 metadataCache。
 * 这里只遍历一次文件列表、取一次 cache，再交给四个扫描器共享的
 * cache 级 helper；输出仍按 (sourcePath, offset) 排序，与四个独立入口完全一致。
 */
export function findVaultLinkScans(
	app: App,
	imageExtensions: string,
	files: TFile[] = app.vault.getMarkdownFiles(),
): VaultLinkScans {
	const images = parseExtensions(imageExtensions);
	const nativeImages = nativeImageExtensionSet(imageExtensions);
	const brokenLinks: BrokenImageLink[] = [];
	const nativeLinks: NativeImageLink[] = [];
	const brokenNoteLinks: BrokenNoteLink[] = [];
	const wikiLinks: WikiNoteLink[] = [];
	for (const file of files) {
		const cache = app.metadataCache.getFileCache(file);
		if (!cache) continue;
		brokenLinks.push(...collectBrokenImageLinks(app, file.path, cache, images));
		nativeLinks.push(...collectNativeImageLinks(app, file.path, cache, nativeImages));
		brokenNoteLinks.push(...collectBrokenNoteLinks(app, file.path, cache, images));
		wikiLinks.push(...collectWikiNoteLinks(app, file.path, cache));
	}
	return {
		brokenLinks: sortBySourceAndOffset(brokenLinks),
		nativeLinks: sortBySourceAndOffset(nativeLinks),
		brokenNoteLinks: sortBySourceAndOffset(brokenNoteLinks),
		wikiLinks: sortBySourceAndOffset(wikiLinks),
	};
}

function sortBySourceAndOffset<T extends PositionedLink>(links: T[]): T[] {
	return links.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.position.start.offset - b.position.start.offset);
}
