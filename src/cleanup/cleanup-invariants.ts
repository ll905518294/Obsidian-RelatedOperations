import { CLEANUP_CATEGORIES, CLEANUP_PAGE_SIZE, type CleanupViewContext, type CleanupTab } from './cleanup-types.ts';
import { categoryCount } from './cleanup-selectors.ts';

declare const process: { env: { NODE_ENV?: string } };

const CATEGORY_TABS = new Set<string>(CLEANUP_CATEGORIES.map((category) => category.tab));

export function lastPageIndex(total: number, pageSize: number): number {
	return Math.max(0, Math.ceil(total / pageSize) - 1);
}

export function pageIndexInBounds(page: number, total: number, pageSize: number): boolean {
	return Number.isInteger(page) && page >= 0 && page <= lastPageIndex(total, pageSize);
}

function tabSetIssues(name: string, tabs: Set<CleanupTab>): string[] {
	const issues: string[] = [];
	for (const tab of tabs) if (!CATEGORY_TABS.has(tab)) issues.push(`${name} 含非分类标签：${tab}`);
	return issues;
}

function scanStateIssues(state: CleanupViewContext): string[] {
	const issues: string[] = [];
	if (!state.scanning) return issues;
	if (state.activeTab !== 'overview') issues.push(`全量扫描时 activeTab 应为 overview，实际为 ${state.activeTab}`);
	if (state.scanningTabs.size > 0) issues.push(`全量扫描时 scanningTabs 应为空，实际含 ${state.scanningTabs.size} 项`);
	return issues;
}

function progressIssues(state: CleanupViewContext): string[] {
	const issues: string[] = [];
	const { stage, processed, total } = state.scanProgress;
	if (state.scanStages.length > 0 && (!Number.isInteger(stage) || stage < 0 || stage >= state.scanStages.length)) {
		issues.push(`scanProgress.stage=${stage} 超出 ${state.scanStages.length} 个扫描阶段`);
	}
	if (processed < 0 || total < 0) issues.push(`scanProgress 计数为负：processed=${processed} total=${total}`);
	if (state.scanElapsedMs < 0) issues.push(`scanElapsedMs 为负：${state.scanElapsedMs}`);
	return issues;
}

function pageIssues(state: CleanupViewContext): string[] {
	const issues: string[] = [];
	for (const [tab, page] of state.pages) {
		if (!CATEGORY_TABS.has(tab)) {
			issues.push(`pages 含非分类标签：${tab}`);
			continue;
		}
		if (!Number.isInteger(page) || page < 0) issues.push(`pages[${tab}] 不是非负整数：${page}`);
	}
	const active = state.activeTab;
	if (active !== 'overview' && state.pages.has(active)) {
		const page = state.pages.get(active)!;
		const total = categoryCount(state.candidates, active);
		if (!pageIndexInBounds(page, total, CLEANUP_PAGE_SIZE)) {
			issues.push(`pages[${active}]=${page} 超出 ${total} 项的页数范围`);
		}
	}
	return issues;
}

function selectionKeyIssues(state: CleanupViewContext): string[] {
	const issues: string[] = [];
	const pathSets: Array<[string, Set<string>]> = [
		['selections', state.selections],
		['duplicateSelections', state.duplicateSelections],
	];
	for (const [name, selection] of pathSets) {
		for (const path of selection) {
			if (!path) issues.push(`${name} 含空路径`);
			else if (path.includes('\u0000')) issues.push(`${name} 含链接键格式的路径：${path}`);
		}
	}
	const linkSets: Array<[string, Set<string>]> = [
		['linkSelections', state.linkSelections],
		['nativeSelections', state.nativeSelections],
		['noteLinkSelections', state.noteLinkSelections],
	];
	for (const [name, selection] of linkSets) {
		for (const key of selection) {
			const parts = key.split('\u0000');
			if (parts.length !== 2 || !parts[0] || !parts[1]) issues.push(`${name} 含格式错误的链接键：${JSON.stringify(key)}`);
		}
	}
	return issues;
}

export function checkCleanupInvariants(state: CleanupViewContext): string[] {
	return [
		...tabSetIssues('scannedTabs', state.scannedTabs),
		...tabSetIssues('scanningTabs', state.scanningTabs),
		...tabSetIssues('dirtyTabs', state.dirtyTabs),
		...scanStateIssues(state),
		...progressIssues(state),
		...pageIssues(state),
		...selectionKeyIssues(state),
	];
}

export function pathSelectionsOutsideCandidates(state: CleanupViewContext): string[] {
	const known = new Set<string>([
		...state.candidates.images.map((item) => item.path),
		...state.candidates.attachments.map((item) => item.path),
		...state.candidates.emptyFiles.map((item) => item.path),
		...state.candidates.folders.map((item) => item.path),
	]);
	return [...state.selections].filter((path) => !known.has(path));
}

export function duplicateSelectionsOutsideGroups(state: CleanupViewContext): string[] {
	const known = new Set<string>(state.candidates.duplicates.flatMap((group) => group.files.map((file) => file.path)));
	return [...state.duplicateSelections].filter((path) => !known.has(path));
}

let lastReport = '';

export function reportCleanupInvariants(state: CleanupViewContext): void {
	if (process.env.NODE_ENV === 'production') return;
	const issues = checkCleanupInvariants(state);
	if (issues.length === 0) {
		lastReport = '';
		return;
	}
	const message = issues.join('\n');
	if (message === lastReport) return;
	lastReport = message;
	console.warn(`[cleanup-invariants] ${message}`);
}
