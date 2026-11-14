export interface LinkStatsValue {
	incoming: number;
	outgoing: number;
	bidirectional: number;
}

export function findChangedLinkPaths(
	previous: Record<string, Record<string, number>>,
	current: Record<string, Record<string, number>>,
): Set<string> {
	const changed = new Set<string>();
	const sources = new Set([...Object.keys(previous), ...Object.keys(current)]);
	for (const source of sources) {
		const before = previous[source] ?? {};
		const after = current[source] ?? {};
		const targets = new Set([...Object.keys(before), ...Object.keys(after)]);
		let different = false;
		for (const target of targets) {
			if ((before[target] ?? 0) !== (after[target] ?? 0)) {
				different = true;
				changed.add(target);
			}
		}
		if (different) changed.add(source);
	}

	// A rename/delete drops the old path as a source, but notes that still carry
	// a (possibly stale) link to that old path are not part of the edge diff if
	// their own destination map is unchanged. Refresh them so their counts
	// settle even when the metadata cache lags behind the rename event. This
	// extra sweep only runs when a source actually disappeared, so ordinary
	// edits keep the cheap edge-diff cost.
	const removedSources = Object.keys(previous).filter((source) => !Object.prototype.hasOwnProperty.call(current, source));
	if (removedSources.length > 0) {
		const removed = new Set(removedSources);
		for (const [source, targets] of Object.entries(previous)) {
			for (const target of Object.keys(targets)) {
				if (removed.has(target)) changed.add(source);
			}
		}
		for (const source of removedSources) changed.add(source);
	}
	return changed;
}

export function findLinkStatsPropertyNameConflicts(
	frontmatter: Record<string, unknown> | undefined,
	oldNames: readonly string[],
	nextNames: readonly string[],
): string[] {
	if (!frontmatter) return [];
	const oldKeys = new Set(oldNames);
	return [...new Set(nextNames)]
		.filter((key) => !oldKeys.has(key) && Object.prototype.hasOwnProperty.call(frontmatter, key));
}

export function buildLinkStatsIndex(
	resolved: Record<string, Record<string, number>>,
	requestedPaths: Set<string>,
	markdownPaths: Set<string>,
): Map<string, LinkStatsValue> {
	const outgoingByPath = new Map<string, Set<string>>();
	const incomingByPath = new Map<string, Set<string>>();
	for (const [sourcePath, destinations] of Object.entries(resolved)) {
		if (!markdownPaths.has(sourcePath)) continue;
		const sourceRequested = requestedPaths.has(sourcePath);
		for (const targetPath of Object.keys(destinations)) {
			if (!markdownPaths.has(targetPath)) continue;
			if (sourceRequested) (outgoingByPath.get(sourcePath) ?? (outgoingByPath.set(sourcePath, new Set()), outgoingByPath.get(sourcePath)!)).add(targetPath);
			if (requestedPaths.has(targetPath)) (incomingByPath.get(targetPath) ?? (incomingByPath.set(targetPath, new Set()), incomingByPath.get(targetPath)!)).add(sourcePath);
		}
	}
	const statsByPath = new Map<string, LinkStatsValue>();
	for (const path of requestedPaths) {
		const outgoing = outgoingByPath.get(path) ?? new Set<string>();
		const incoming = incomingByPath.get(path) ?? new Set<string>();
		statsByPath.set(path, { incoming: incoming.size, outgoing: outgoing.size, bidirectional: [...outgoing].filter((target) => incoming.has(target)).length });
	}
	return statsByPath;
}
