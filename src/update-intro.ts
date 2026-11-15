import { Modal, type App } from 'obsidian';
import type { UpdateIntro } from './update-intro-content';

export class UpdateIntroModal extends Modal {
	constructor(app: App, private readonly name: string, private readonly intro: UpdateIntro) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(`${this.name} · ${this.intro.version} · ${this.intro.theme}`);
		this.modalEl.addClass('update-intro-modal');
		this.contentEl.createEl('p', { text: this.intro.summary, cls: 'update-intro-summary' });
		this.contentEl.createEl('h4', { text: '本次更新', cls: 'update-intro-heading' });
		for (const section of this.intro.sections) {
			const block = this.contentEl.createDiv({ cls: 'update-intro-section' });
			block.createEl('h5', { text: section.title, cls: 'update-intro-section-title' });
			const list = block.createEl('ul', { cls: 'update-intro-list' });
			for (const item of section.items) list.createEl('li', { text: item, cls: 'update-intro-item' });
		}
		const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const start = actions.createEl('button', { text: '开始使用', cls: 'mod-cta' });
		start.addEventListener('click', () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
