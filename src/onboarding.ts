import { Modal, type App } from 'obsidian';
import { ONBOARDING_STEPS } from './onboarding-content';

export type OnboardingAction = 'start' | 'cleanup' | 'skip';

export class OnboardingModal extends Modal {
	private step = 0;

	constructor(app: App, private readonly onAction: (action: OnboardingAction) => void = () => {}) {
		super(app);
	}

	onOpen() {
		// Reuse the readable update-intro tokens; both modals share the same
		// body/list styling without adding global rules.
		this.modalEl.addClass('update-intro-modal', 'onboarding-modal');
		this.renderStep();
	}

	private renderStep() {
		const total = ONBOARDING_STEPS.length;
		const current = ONBOARDING_STEPS[this.step]!;
		this.titleEl.setText(`使用引导（${this.step + 1}/${total}）`);
		this.contentEl.empty();
		this.contentEl.createEl('h4', { text: current.title, cls: 'update-intro-heading' });
		this.contentEl.createEl('p', { text: current.summary, cls: 'update-intro-summary' });
		const block = this.contentEl.createDiv({ cls: 'update-intro-section' });
		const list = block.createEl('ul', { cls: 'update-intro-list' });
		for (const item of current.items) {
			const row = list.createEl('li', { cls: 'update-intro-item' });
			row.appendText(item.text);
			if (item.kbd) row.createEl('kbd', { text: item.kbd });
			if (item.after) row.appendText(item.after);
		}
		const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
		if (this.step > 0) {
			actions.createEl('button', { text: '上一步' }).addEventListener('click', () => {
				this.step -= 1;
				this.renderStep();
			});
		}
		if (this.step < total - 1) {
			const next = actions.createEl('button', { text: '下一步', cls: 'mod-cta' });
			next.addEventListener('click', () => {
				this.step += 1;
				this.renderStep();
			});
			return;
		}
		actions.createEl('button', { text: '跳过' }).addEventListener('click', () => this.finish('skip'));
		actions.createEl('button', { text: '立即打开体检' }).addEventListener('click', () => this.finish('cleanup'));
		actions.createEl('button', { text: '开始使用', cls: 'mod-cta' }).addEventListener('click', () => this.finish('start'));
	}

	private finish(action: OnboardingAction) {
		this.close();
		this.onAction(action);
	}

	onClose() {
		this.contentEl.empty();
	}
}
