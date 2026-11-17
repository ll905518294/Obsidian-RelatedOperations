import { CLEANUP_CATEGORIES, type CleanupCandidates, type CleanupTab, type ScanCategoryTab, type ScanProgress } from './cleanup-types.ts';

export function categoryCount(candidates: CleanupCandidates, tab: ScanCategoryTab): number {
	switch (tab) {
		case 'images': return candidates.images.length;
		case 'attachments': return candidates.attachments.length;
		case 'broken-links': return candidates.brokenLinks.length;
		case 'native-links': return candidates.nativeLinks.length;
		case 'broken-note-links': return candidates.brokenNoteLinks.length;
		case 'wiki-links': return candidates.wikiLinks.length;
		case 'empty-files': return candidates.emptyFiles.length;
		case 'folders': return candidates.folders.length;
		case 'duplicates': return candidates.duplicates.length;
		case 'image-convert': return candidates.convertibleImages.length;
	}
}

export function categoryTotal(candidates: CleanupCandidates): number {
	return CLEANUP_CATEGORIES.reduce((total, category) => total + categoryCount(candidates, category.tab), 0);
}

export function categoryStatus(count: number, scanned: boolean, scanning: boolean, dirty: boolean): string {
	if (scanning) return '正在扫描…';
	if (!scanned) return '尚未扫描';
	if (dirty) return '结果待复核，请重新扫描';
	return count > 0 ? `发现 ${count} 项` : '未发现问题';
}

export function scanPercent(scanning: boolean, stageCount: number, progress: ScanProgress): number {
	const stagePercent = progress.total > 0 ? progress.processed / progress.total : 0;
	return scanning ? Math.min(99, Math.round(((progress.stage + stagePercent) / Math.max(stageCount, 1)) * 100)) : 100;
}

export function pageCount(total: number, pageSize: number): number {
	return Math.ceil(total / pageSize);
}

export function clampPageIndex(current: number, total: number, pageSize: number): number {
	const last = Math.max(0, Math.ceil(total / pageSize) - 1);
	return Math.min(current, last);
}

export function tabEntries(candidates: CleanupCandidates, scanning: boolean): Array<[CleanupTab, string, number]> {
	const categories = CLEANUP_CATEGORIES.map(({ tab, label }) => ({ tab, label, count: categoryCount(candidates, tab) }));
	if (!scanning) categories.sort((a, b) => Number(b.count > 0) - Number(a.count > 0));
	return [
		['overview', '体检首页', categoryTotal(candidates)],
		...categories.map(({ tab, label, count }): [CleanupTab, string, number] => [tab, label, count]),
		['image-convert', '图片压缩', candidates.convertibleImages.length],
	];
}

export function formatScanDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
