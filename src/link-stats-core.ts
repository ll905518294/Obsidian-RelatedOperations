export interface LinkStatsValue {
	incoming: number;
	outgoing: number;
	bidirectional: number;
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
