import { EventRef, MenuItem, TFile, TFolder } from 'obsidian';

export interface NotebookNavigatorSelectionState {
	files: readonly TFile[];
	focused: TFile | null;
}

export interface NotebookNavigatorFileMenuContext {
	addItem(callback: (item: MenuItem) => void): void;
	file: TFile;
	selection: {
		mode: 'single' | 'multiple';
		files: readonly TFile[];
	};
}

export interface NotebookNavigatorFolderMenuContext {
	addItem(callback: (item: MenuItem) => void): void;
	folder: TFolder;
}

export interface NotebookNavigatorApi {
	selection: {
		getCurrent(): NotebookNavigatorSelectionState;
	};
	menus: {
		registerFileMenu(callback: (context: NotebookNavigatorFileMenuContext) => void): () => void;
		registerFolderMenu(callback: (context: NotebookNavigatorFolderMenuContext) => void): () => void;
	};
	on<T extends 'selection-changed'>(event: T, callback: (data: { state: NotebookNavigatorSelectionState }) => void): EventRef;
	off(ref: EventRef): void;
}
