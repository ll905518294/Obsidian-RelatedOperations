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

	const resolveMarkdown = (path: string): TFile | null => {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') return null;
		return file;
	};

	for (const sourceFile of sourceFiles) {
		for (const path of Object.keys(resolvedLinks[sourceFile.path] ?? {})) {
			const targetFile = resolveMarkdown(path);
			if (targetFile) addRelation(sourceFile, targetFile, 'outgoing');
		}
	}

	// Walk resolvedLinks once to discover which linking sources point at a
	// requested note. Resolving each linking source once avoids re-resolving the
	// same source for every requested target it links to.
	for (const [linkingPath, destinations] of Object.entries(resolvedLinks)) {
		const linkingFile = app.vault.getAbstractFileByPath(linkingPath);
		if (!(linkingFile instanceof TFile) || linkingFile.extension.toLowerCase() !== 'md') continue;
		for (const targetPath of Object.keys(destinations)) {
			const sourceFile = sourceByPath.get(targetPath);
			if (sourceFile && linkingFile.path !== sourceFile.path) {
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
