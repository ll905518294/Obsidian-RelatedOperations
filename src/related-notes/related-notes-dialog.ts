import { App, Modal, TFile } from 'obsidian';
import type { RelatedNote } from '../related-notes';
import type { RelatedOperationsSettings } from '../settings';
import { RelatedNotesPanel } from './related-notes-panel';

export class RelatedNotesModal extends Modal {
	private panel?: RelatedNotesPanel;

	constructor(
		app: App,
		private readonly sourceFile: TFile,
		private readonly sourceFiles: TFile[],
		private readonly relatedNotes: RelatedNote[],
		private readonly sourceLabel = sourceFile.basename,
		private readonly sourceCount = sourceFiles.length,
		private readonly settings?: RelatedOperationsSettings,
		private readonly saveSettings?: () => Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('related-operations-modal');
		this.titleEl.setText(`整理关联笔记：${this.sourceLabel}`);
		this.panel = new RelatedNotesPanel(
			this.app,
			this.contentEl,
			this.sourceFile,
			this.sourceFiles,
			this.relatedNotes,
			this,
			this.sourceLabel,
			this.sourceCount,
			this.settings,
			this.saveSettings,
		);
		this.panel.render();
	}

	onClose() {
		this.modalEl.removeClass('related-operations-modal');
		this.contentEl.empty();
	}
}
