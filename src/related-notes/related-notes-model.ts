import { normalizePath, TFile, TFolder, type App } from 'obsidian';
import type { RelatedNote, RelationType } from '../related-notes';

export type RelationGroup = 'outgoing' | 'incoming' | 'both';
export type GroupingMode = 'none' | 'source' | 'path';

export interface RelatedGroups {
	outgoing: RelatedNote[];
	incoming: RelatedNote[];
	both: RelatedNote[];
}

export interface MoveRecord {
	from: string;
	to: string;
}

export interface MoveResult {
	succeeded: string[];
	skipped: string[];
	failed: MoveFailure[];
	moved: MoveRecord[];
}

export type MoveFailureKind = 'exists' | 'target-is-file' | 'permission' | 'other';

export interface MoveFailure {
	path: string;
	reason: string;
	kind: MoveFailureKind;
	nextStep: string;
}

export function parentFolder(path: string) {
	const slash = path.lastIndexOf('/');
	return slash >= 0 ? path.slice(0, slash) : '';
}

export function sortNotes(a: RelatedNote, b: RelatedNote) {
	const folderCompare = parentFolder(a.file.path).localeCompare(parentFolder(b.file.path));
	const sourceCompare = a.sourceFile.path.localeCompare(b.sourceFile.path);
	return folderCompare || sourceCompare || a.file.path.localeCompare(b.file.path);
}

export function buildRelatedGroups(notes: RelatedNote[]): RelatedGroups {
	return {
		outgoing: notes.filter((note) => note.relation === 'outgoing' || note.relation === 'both').sort(sortNotes),
		incoming: notes.filter((note) => note.relation === 'incoming' || note.relation === 'both').sort(sortNotes),
		both: notes.filter((note) => note.relation === 'both').sort(sortNotes),
	};
}

export function sortForDisplay(a: RelatedNote, b: RelatedNote, groupingMode: GroupingMode) {
	const sourceCompare = a.sourceFile.path.localeCompare(b.sourceFile.path);
	const folderCompare = parentFolder(a.file.path).localeCompare(parentFolder(b.file.path));
	return groupingMode === 'source'
		? sourceCompare || folderCompare || a.file.path.localeCompare(b.file.path)
		: folderCompare || sourceCompare || a.file.path.localeCompare(b.file.path);
}

// Single-source rows have no source column, so the relation alone ("出链")
// does not tell the reader which note it refers to. Spell out the direction
// against the source note instead of adding another scan or column.
export function relationExplanation(note: RelatedNote): string {
	const source = note.sourceFile.basename;
	if (note.relation === 'both') return `与 ${source} 双向链接`;
	return note.relation === 'incoming' ? `${source} 的入链` : `出链自 ${source}`;
}

export const RELATION_EXPLANATION_LIMIT = 24;

// The relation column is narrow. Keep the visible explanation within a fixed
// budget and let the caller put the full sentence in the cell's title.
export function relationExplanationText(note: RelatedNote, limit = RELATION_EXPLANATION_LIMIT) {
	const text = relationExplanation(note);
	const chars = Array.from(text);
	return chars.length <= limit ? text : `${chars.slice(0, Math.max(1, limit - 1)).join('')}…`;
}

export function uniqueCount(group: RelatedNote[]) {
	return new Set(group.map((note) => note.file.path)).size;
}

export function relationLabelForSet(relations: Set<RelationType>): string {
	const hasOutgoing = relations.has('outgoing') || relations.has('both');
	const hasIncoming = relations.has('incoming') || relations.has('both');
	if (hasOutgoing && hasIncoming) return '出链 + 入链';
	return hasOutgoing ? '出链' : '入链';
}

export function mergedRelationLabel(notes: RelatedNote[]): string {
	return relationLabelForSet(new Set(notes.map((note) => note.relation)));
}

export function mergedRelationDetail(notes: RelatedNote[]): Array<{ name: string; path: string; label: string }> {
	const bySource = new Map<string, { name: string; path: string; relations: Set<RelationType> }>();
	for (const note of notes) {
		const entry = bySource.get(note.sourceFile.path) ?? { name: note.sourceFile.basename, path: note.sourceFile.path, relations: new Set<RelationType>() };
		entry.relations.add(note.relation);
		bySource.set(note.sourceFile.path, entry);
	}
	return [...bySource.values()].map((entry) => ({ name: entry.name, path: entry.path, label: relationLabelForSet(entry.relations) }));
}

export function relatedKey(note: RelatedNote, fallbackSourcePath: string) {
	return `${note.sourceFile?.path ?? fallbackSourcePath}\u0000${note.file.path}`;
}

export function finalTarget(targetFolder: string) {
	return normalizePath(targetFolder.trim()).replace(/^\/+|\/+$/g, '');
}

export function destinationFor(file: TFile, targetFolder: string) {
	const target = finalTarget(targetFolder);
	return target ? `${target}/${file.name}` : file.name;
}

export function isAlreadyAtTarget(file: TFile, targetFolder: string) {
	return normalizePath(parentFolder(file.path)).toLowerCase() === normalizePath(finalTarget(targetFolder)).toLowerCase();
}

export interface TargetFolderCheck {
	state: 'folder' | 'missing' | 'blocked';
	blocker?: string;
}

export function targetFolderStatus(app: App, targetFolder: string): TargetFolderCheck {
	const target = finalTarget(targetFolder);
	if (!target) return { state: 'missing' };
	let current = '';
	for (const segment of target.split('/')) {
		current = current ? `${current}/${segment}` : segment;
		const entry = app.vault.getAbstractFileByPath(current);
		if (!entry) return { state: 'missing' };
		if (!(entry instanceof TFolder)) return { state: 'blocked', blocker: current };
	}
	return { state: 'folder' };
}

export function formatMoveResult(result: MoveResult) {
	const lines = [`已移动：${result.succeeded.length}`, `已跳过：${result.skipped.length}`, `失败：${result.failed.length}`];
	if (result.skipped.length) lines.push(`跳过文件：${result.skipped.join('、')}`);
	if (result.failed.length) {
		lines.push('失败文件：');
		for (const item of result.failed) lines.push(`- ${item.path}：${item.reason}。${item.nextStep}`);
	}
	return lines.join('\n');
}
