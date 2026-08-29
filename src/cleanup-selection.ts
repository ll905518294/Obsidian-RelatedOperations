export function selectCurrentCleanupItems<T extends { path: string }>(selectedPaths: Iterable<string>, currentItems: T[]) {
	const selected = new Set(selectedPaths);
	const items = currentItems.filter((item) => selected.has(item.path));
	const currentPaths = new Set(items.map((item) => item.path));
	return { items, skipped: [...selected].filter((path) => !currentPaths.has(path)) };
}
