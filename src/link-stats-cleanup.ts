export type LinkStatsPropertyNames = {
	incomingProperty: string;
	outgoingProperty: string;
	bidirectionalProperty: string;
};

// Historical default names the plugin wrote before the feature was retired.
// They are kept so the one-time cleanup can find properties written by any
// released version even after a user changed the property names in settings.
export const HISTORICAL_LINK_STATS_PROPERTY_NAMES: LinkStatsPropertyNames = {
	incomingProperty: 'related-operations-in-links',
	outgoingProperty: 'related-operations-out-links',
	bidirectionalProperty: 'related-operations-bidirectional-links',
};

export interface LinkStatsPropertyEntry {
	path: string;
	matchedKeys: string[];
}

// Collects, across a list of frontmatter objects, which target names actually
// exist as keys. Only these keys are ever touched by cleanup; every other field
// is left untouched. Names should already be deduplicated and non-empty.
export function collectLinkStatsPropertyEntries(
	frontmatterList: ReadonlyArray<{ path: string; frontmatter?: Record<string, unknown> | null }>,
	names: readonly string[],
): LinkStatsPropertyEntry[] {
	const keys = new Set(names);
	const entries: LinkStatsPropertyEntry[] = [];
	for (const item of frontmatterList) {
		if (!item.frontmatter) continue;
		const matchedKeys = names.filter((name) =>
			keys.has(name) && Object.prototype.hasOwnProperty.call(item.frontmatter, name),
		);
		if (matchedKeys.length > 0) entries.push({ path: item.path, matchedKeys });
	}
	return entries;
}

export interface LinkStatsCleanupSummary {
	cleaned: number;
	skipped: number;
	failed: Array<{ path: string; reason: string }>;
}

// Removes the collected property keys from each matched note. Any single-file
// failure does not stop the rest; it is reported in `failed`. `shouldSkip` lets
// a caller keep a note out (e.g. a user-backed-up or already-processed file)
// without treating it as failure.
export async function removeLinkStatsPropertyEntries(
	entries: ReadonlyArray<LinkStatsPropertyEntry>,
	remove: (path: string, keys: readonly string[]) => Promise<void>,
	shouldSkip: (path: string) => boolean = () => false,
): Promise<LinkStatsCleanupSummary> {
	const summary: LinkStatsCleanupSummary = { cleaned: 0, skipped: 0, failed: [] };
	for (const entry of entries) {
		if (shouldSkip(entry.path)) {
			summary.skipped++;
			continue;
		}
		try {
			await remove(entry.path, entry.matchedKeys);
			summary.cleaned++;
		} catch (error) {
			summary.failed.push({
				path: entry.path,
				reason: error instanceof Error ? error.message : '未知错误',
			});
		}
	}
	return summary;
}
