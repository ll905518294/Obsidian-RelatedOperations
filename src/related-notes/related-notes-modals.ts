import { App, Modal } from 'obsidian';

export class MoveConfirmationModal extends Modal {
	private resolver?: (confirmed: boolean) => void;
	private settled = false;

	constructor(
		app: App,
		private readonly targetFolder: string,
		private readonly movableCount: number,
		private readonly conflictCount: number,
	) {
		super(app);
	}

	waitForConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolver = resolve;
			this.open();
		});
	}

	onOpen() {
		this.titleEl.setText('确认整理笔记');
		this.contentEl.empty();
		this.contentEl.createEl('p', { text: `即将整理 ${this.movableCount} 篇笔记到：` });
		this.contentEl.createEl('p', { text: this.targetFolder, cls: 'related-operations-confirm-target' });
		if (this.conflictCount > 0) {
			this.contentEl.createEl('p', {
				text: `${this.conflictCount} 篇笔记存在冲突，将自动跳过。`,
				cls: 'related-operations-confirm-warning',
			});
		}
		const actions = this.contentEl.createDiv({ cls: 'related-operations-actions' });
		const confirm = actions.createEl('button', { text: '确认整理', cls: 'mod-cta' });
		confirm.addEventListener('click', () => this.finish(true));
		const cancel = actions.createEl('button', { text: '取消' });
		cancel.addEventListener('click', () => this.finish(false));
	}

	onClose() {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.resolver?.(false);
		}
	}

	private finish(confirmed: boolean) {
		if (this.settled) return;
		this.settled = true;
		this.resolver?.(confirmed);
		this.close();
	}
}
