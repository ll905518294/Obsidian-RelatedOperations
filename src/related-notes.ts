import { App, TFile } from 'obsidian';

export type RelationType = 'outgoing' | 'incoming' | 'both';

export interface RelatedNote {
	file: TFile;
	relation: RelationType;
	sourceFile: TFile;
}

export function getRelatedNotes(app: App, sourceFile: TFile): RelatedNote[] {
	return getRelatedNotesForFiles(app, [sourceFile]);
}

export function getRelatedNotesForFiles(app: App, sourceFiles: TFile[]): RelatedNote[] {
	const resolvedLinks = app.metadataCache.resolvedLinks;
	const relationByKey = new Map<string, {
		sourceFile: TFile;
		targetFile: TFile;
		relations: Set<'outgoing' | 'incoming'>;
	}>();
	const sourceByPath = new Map(sourceFiles.map((file) => [file.path, file]));
	const sourcePaths = new Set(sourceByPath.keys());

	const addRelation = (sourceFile: TFile, targetFile: TFile, relation: 'outgoing' | 'incoming') => {
		if (sourcePaths.has(targetFile.path)) return;
		const key = `${sourceFile.path}\u0000${targetFile.path}`;
		const association = relationByKey.get(key) ?? {
			sourceFile,
			targetFile,
			relations: new Set<'outgoing' | 'incoming'>(),
		};
		association.relations.add(relation);
		relationByKey.set(key, association);
	};

	// Both passes share one path→file memo: selected sources commonly share
	// targets (folders, MOCs), and the same key may also appear as a linking
	// source. Resolve each distinct path at most once per call.
	const resolvedByPath = new Map<string, TFile | null>();
	const resolveMarkdown = (path: string): TFile | null => {
		const cached = resolvedByPath.get(path);
		if (cached !== undefined) return cached;
		const file = app.vault.getAbstractFileByPath(path);
		const resolved = file instanceof TFile && file.extension.toLowerCase() === 'md' ? file : null;
		resolvedByPath.set(path, resolved);
		return resolved;
	};

	for (const sourceFile of sourceFiles) {
		const destinations = resolvedLinks[sourceFile.path];
		if (!destinations) continue;
		for (const path of Object.keys(destinations)) {
			const targetFile = resolveMarkdown(path);
			if (targetFile) addRelation(sourceFile, targetFile, 'outgoing');
		}
	}

	// Walk resolvedLinks once to discover which linking sources point at a
	// requested note. Resolving each linking source once avoids re-resolving the
	// same source for every requested target it links to.
	for (const [linkingPath, destinations] of Object.entries(resolvedLinks)) {
		let linkingFile: TFile | null | undefined;
		for (const targetPath of Object.keys(destinations)) {
			const sourceFile = sourceByPath.get(targetPath);
			if (!sourceFile) continue;
			// Resolve the linking source only when it actually points at a
			// requested note; unrelated notes in a large vault never cost a
			// vault lookup.
			if (linkingFile === undefined) linkingFile = resolveMarkdown(linkingPath);
			if (linkingFile && linkingFile.path !== sourceFile.path) {
				addRelation(sourceFile, linkingFile, 'incoming');
			}
		}
	}

	return [...relationByKey.values()]
		.map(({ sourceFile, targetFile, relations }) => {
			const relation: RelationType = relations.size === 2
				? 'both'
				: relations.has('outgoing')
					? 'outgoing'
					: 'incoming';
			return { file: targetFile, relation, sourceFile };
		})
		.sort((a, b) => a.file.path.localeCompare(b.file.path));
}

export function defaultTargetFolder(sourceFile: TFile): string {
	const lastSlash = sourceFile.path.lastIndexOf('/');
	const parent = lastSlash >= 0 ? sourceFile.path.slice(0, lastSlash) : '';
	return parent ? `${parent}/${sourceFile.basename}` : sourceFile.basename;
}

export function relationLabel(relation: RelationType): string {
	if (relation === 'both') return '出链 + 入链';
	return relation === 'outgoing' ? '出链' : '入链';
}
