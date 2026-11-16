import { App, Modal } from 'obsidian';
import { targetFolderStatus } from './related-notes-model';

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
		this.contentEl.createEl('p', { text: `即将把 ${this.movableCount} 篇笔记移动到：` });
		this.contentEl.createEl('p', { text: this.targetFolder, cls: 'related-operations-confirm-target' });
		const targetCheck = targetFolderStatus(this.app, this.targetFolder);
		this.contentEl.createEl('p', {
			text: targetCheck.state === 'folder'
				? '目标文件夹已存在。'
				: targetCheck.state === 'blocked'
					? `目标路径中的「${targetCheck.blocker}」是文件，无法作为目标文件夹。`
					: '目标文件夹尚不存在，将在移动时自动创建。',
			cls: targetCheck.state === 'folder' ? '' : 'related-operations-confirm-warning',
		});
		if (this.conflictCount > 0) {
			this.contentEl.createEl('p', {
				text: `${this.conflictCount} 篇笔记因目标位置已有同名笔记而自动跳过；请改用其他目标文件夹，或先重命名冲突笔记。`,
				cls: 'related-operations-confirm-warning',
			});
		}
		this.contentEl.createEl('p', { text: '移动后可在面板中点击「撤销本次移动」恢复。' });
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
