import { App, TFile } from 'obsidian';

export interface LinkStatsSettings {
	enabled: boolean;
	autoUpdate: boolean;
	incomingProperty: string;
	outgoingProperty: string;
	bidirectionalProperty: string;
}

export type LinkStatsPropertyNames = Pick<LinkStatsSettings, 'incomingProperty' | 'outgoingProperty' | 'bidirectionalProperty'>;

export interface LinkStats {
	incoming: number;
	outgoing: number;
	bidirectional: number;
}

export function getLinkStats(app: App, file: TFile): LinkStats {
	const resolved = app.metadataCache.resolvedLinks;
	const outgoing = new Set(
		Object.keys(resolved[file.path] ?? {}).filter((path) => {
			const target = app.vault.getAbstractFileByPath(path);
			return target instanceof TFile && target.extension.toLowerCase() === 'md';
		}),
	);
	const incoming = new Set<string>();
	for (const [sourcePath, destinations] of Object.entries(resolved)) {
		const source = app.vault.getAbstractFileByPath(sourcePath);
		if (source instanceof TFile && source.extension.toLowerCase() === 'md' && Object.prototype.hasOwnProperty.call(destinations, file.path)) {
			incoming.add(sourcePath);
		}
	}
	return {
		incoming: incoming.size,
		outgoing: outgoing.size,
		bidirectional: [...outgoing].filter((path) => incoming.has(path)).length,
	};
}

export async function updateLinkStats(app: App, files: TFile[], settings: LinkStatsSettings): Promise<number> {
	let updated = 0;
	for (const file of files) {
		const stats = getLinkStats(app, file);
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
