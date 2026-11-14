import { App, Modal } from 'obsidian';

export function confirmLinkStatsCleanup(
	app: App,
	noteCount: number,
	propertyCount: number,
	samplePaths: readonly string[],
): Promise<boolean> {
	return new Promise((resolve) => {
		new LinkStatsCleanupConfirmModal(app, noteCount, propertyCount, samplePaths, resolve).open();
	});
}

class LinkStatsCleanupConfirmModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly noteCount: number,
		private readonly propertyCount: number,
		private readonly samplePaths: readonly string[],
		private readonly resolve: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText('确认清除关联数量属性');
		this.contentEl.empty();
		this.contentEl.createEl('p', {
			text: `将在 ${this.noteCount} 篇笔记中移除 ${this.propertyCount} 个关联数量属性。`,
		});
		if (this.samplePaths.length > 0) {
			const list = this.contentEl.createEl('ul');
			for (const path of this.samplePaths) list.createEl('li', { text: path });
		}
		this.contentEl.createEl('p', { text: '只删除这三个属性字段，其他 frontmatter 内容保持不变。' });
		const actions = this.contentEl.createDiv({ cls: 'related-operations-actions' });
		const confirm = actions.createEl('button', { text: '清除', cls: 'mod-cta' });
		confirm.addEventListener('click', () => this.finish(true));
		const cancel = actions.createEl('button', { text: '取消' });
		cancel.addEventListener('click', () => this.finish(false));
	}

	onClose() {
		this.contentEl.empty();
		this.finish(false);
	}

	private finish(confirmed: boolean) {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(confirmed);
		if (confirmed) this.close();
	}
}
