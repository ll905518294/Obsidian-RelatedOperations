import type { App, TFile } from 'obsidian';
import { buildLinkStatsIndex, findLinkStatsPropertyNameConflicts } from './link-stats-core';
export { buildLinkStatsIndex } from './link-stats-core';

export interface LinkStatsSettings {
	enabled: boolean;
	autoUpdate: boolean;
	incomingProperty: string;
	outgoingProperty: string;
	bidirectionalProperty: string;
}

export type LinkStatsPropertyNames = Pick<LinkStatsSettings, 'incomingProperty' | 'outgoingProperty' | 'bidirectionalProperty'>;

export interface LinkStatsPropertyConflict {
	path: string;
	property: string;
}

export interface LinkStats {
	incoming: number;
	outgoing: number;
	bidirectional: number;
}

export function getLinkStats(app: App, file: TFile): LinkStats {
	return getLinkStatsForFiles(app, [file]).get(file.path) ?? { incoming: 0, outgoing: 0, bidirectional: 0 };
}

// Builds incoming/outgoing indexes in a single pass over resolvedLinks so that a
// vault-wide refresh costs O(links + notes) instead of O(notes × links).
export function getLinkStatsForFiles(app: App, files: TFile[]): Map<string, LinkStats> {
	const resolved = app.metadataCache.resolvedLinks;
	const mdPaths = new Set(files.map((file) => file.path));
	const allMarkdownPaths = new Set(app.vault.getMarkdownFiles().map((file) => file.path));
	return buildLinkStatsIndex(resolved, mdPaths, allMarkdownPaths);
}

export async function updateLinkStats(app: App, files: TFile[], settings: LinkStatsSettings): Promise<number> {
	const statsByPath = getLinkStatsForFiles(app, files);
	let updated = 0;
	for (const file of files) {
		const stats = statsByPath.get(file.path) ?? { incoming: 0, outgoing: 0, bidirectional: 0 };
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		const values = [
			[settings.incomingProperty, stats.incoming],
			[settings.outgoingProperty, stats.outgoing],
			[settings.bidirectionalProperty, stats.bidirectional],
		] as const;
		const needsUpdate = values.some(([key, value]) => frontmatter?.[key] !== value);
		if (!needsUpdate) continue;
		await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			for (const [key, value] of values) fm[key] = value;
		});
		updated++;
	}
	return updated;
}

export async function migrateLinkStatsProperties(
	app: App,
	files: TFile[],
	oldNames: LinkStatsPropertyNames,
	newNames: LinkStatsPropertyNames,
): Promise<number> {
	const oldKeys = Object.values(oldNames);
	const newKeys = Object.values(newNames);
	if (oldKeys.every((key, index) => key === newKeys[index])) return 0;

	let migrated = 0;
	for (const file of files) {
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		if (!frontmatter || !oldKeys.some((key) => Object.prototype.hasOwnProperty.call(frontmatter, key))) continue;
		const values = {
			incomingProperty: frontmatter[oldNames.incomingProperty] as unknown,
			outgoingProperty: frontmatter[oldNames.outgoingProperty] as unknown,
			bidirectionalProperty: frontmatter[oldNames.bidirectionalProperty] as unknown,
		};
		await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			for (const key of oldKeys) {
				if (!newKeys.includes(key)) delete fm[key];
			}
			for (const [role, key] of Object.entries(newNames) as [keyof LinkStatsPropertyNames, string][]) {
				if (values[role] !== undefined) fm[key] = values[role];
			}
		});
		migrated++;
	}
	return migrated;
}

export function findLinkStatsPropertyConflicts(
	app: App,
	files: TFile[],
	oldNames: LinkStatsPropertyNames,
	nextNames: LinkStatsPropertyNames,
): LinkStatsPropertyConflict[] {
	return files.flatMap((file) => {
		const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
		return findLinkStatsPropertyNameConflicts(frontmatter, Object.values(oldNames), Object.values(nextNames))
			.map((property) => ({ path: file.path, property }));
	});
}
