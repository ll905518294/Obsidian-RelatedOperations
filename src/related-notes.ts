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
		targetPath: string;
		relations: Set<'outgoing' | 'incoming'>;
	}>();
	const sourcePaths = new Set(sourceFiles.map((file) => file.path));

	const addRelation = (sourceFile: TFile, targetPath: string, relation: 'outgoing' | 'incoming') => {
		const file = app.vault.getAbstractFileByPath(targetPath);
		if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') return;
		if (sourcePaths.has(file.path)) return;
		const key = `${sourceFile.path}\u0000${file.path}`;
		const association = relationByKey.get(key) ?? {
			sourceFile,
			targetPath: file.path,
			relations: new Set<'outgoing' | 'incoming'>(),
		};
		association.relations.add(relation);
		relationByKey.set(key, association);
	};

	for (const sourceFile of sourceFiles) {
		for (const path of Object.keys(resolvedLinks[sourceFile.path] ?? {})) {
			addRelation(sourceFile, path, 'outgoing');
		}
	}

	const sourceByPath = new Map(sourceFiles.map((file) => [file.path, file]));
	for (const [linkingPath, destinations] of Object.entries(resolvedLinks)) {
		const linkingFile = app.vault.getAbstractFileByPath(linkingPath);
		if (!(linkingFile instanceof TFile) || linkingFile.extension.toLowerCase() !== 'md') continue;
		for (const targetPath of Object.keys(destinations)) {
			const sourceFile = sourceByPath.get(targetPath);
			if (sourceFile && linkingPath !== sourceFile.path) {
				addRelation(sourceFile, linkingPath, 'incoming');
			}
		}
	}

	return [...relationByKey.values()]
		.map(({ sourceFile, targetPath, relations }) => {
			const file = app.vault.getAbstractFileByPath(targetPath);
			if (!(file instanceof TFile)) return null;
			const relation: RelationType = relations.size === 2
				? 'both'
				: relations.has('outgoing')
					? 'outgoing'
					: 'incoming';
			return { file, relation, sourceFile };
		})
		.filter((note): note is RelatedNote => note !== null)
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
