import type { App, TFile } from 'obsidian';
import type { RelatedNote } from '../related-notes';
import type { RelatedOperationsSettings } from '../settings';
import type { GroupingMode, RelatedGroups, RelationGroup } from './related-notes-model';

export interface RelatedNotesListHost {
	readonly app: App;
	readonly containerEl: HTMLElement;
	readonly sourceFile: TFile;
	readonly sourceCount: number;
	readonly showSourceColumn: boolean;
	readonly settings?: RelatedOperationsSettings;
	readonly saveSettings?: () => Promise<void>;
	readonly onMergingChange?: (merging: boolean) => void;
	relatedNotes(): RelatedNote[];
	groups(): RelatedGroups;
	selections(): Map<string, boolean>;
	targetFolder(): string;
	activeGroup(): RelationGroup;
	groupingMode(): GroupingMode;
	setGroupingMode(value: GroupingMode): void;
	hideCompliant(): boolean;
	setHideCompliant(value: boolean): void;
	merging(): boolean;
	setMerging(value: boolean): void;
	renderList(): void;
	refreshSelectAll(): void;
	syncRowCheckboxes(group: RelatedNote[]): void;
	updateSelectionSummary(): void;
	updateSelectAllState(selectAll: HTMLButtonElement, group: RelatedNote[]): void;
	updateMoveButton(): void;
}
