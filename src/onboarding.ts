import { Modal, type App } from 'obsidian';
import { ONBOARDING_STEPS } from './onboarding-content';
import step1What from '../assets/onboarding/step1-what.png';
import step2Safety from '../assets/onboarding/step2-safety.png';
import step3Start from '../assets/onboarding/step3-start.png';

export type OnboardingAction = 'start' | 'cleanup' | 'skip';

export interface OnboardingMeta {
	name: string;
	version: string;
}

interface OnboardingFigure {
	image: string;
	alt: string;
	caption: string;
}

const ONBOARDING_FIGURES: OnboardingFigure[] = [
	{
		image: step1What,
		alt: '体检面板扫描完成后的结果页',
		caption: '扫描完成后，体检面板会按问题分类列出统计与待处理项（例如 9 类体检结果）。',
	},
	{
		image: step2Safety,
		alt: '重复文件列表页',
		caption: '在列表中勾选需要处理的条目，经你确认后才执行；删除还需二次确认。',
	},
	{
		image: step3Start,
		alt: '体检面板首页',
		caption: '打开体检面板后，点右上角「开始扫描」即可开始检查整个库。',
	},
];

export class OnboardingModal extends Modal {
	private step = 0;

	constructor(
		app: App,
		private readonly meta: OnboardingMeta,
		private readonly onAction: (action: OnboardingAction) => void = () => {},
	) {
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
		this.titleEl.setText(`${this.meta.name} · 使用引导（第 ${this.step + 1}/${total} 步）`);
		this.contentEl.empty();
		this.contentEl.createEl('p', { text: `版本 ${this.meta.version}`, cls: 'update-intro-summary' });
		this.contentEl.createEl('h4', { text: current.title, cls: 'update-intro-heading' });
		this.contentEl.createEl('p', { text: current.summary, cls: 'update-intro-summary' });
		const figure = ONBOARDING_FIGURES[this.step];
		if (figure) {
			const fig = this.contentEl.createEl('figure', { cls: 'onboarding-figure' });
			fig.createEl('img', { cls: 'onboarding-image', attr: { src: figure.image, alt: figure.alt } });
			fig.createEl('figcaption', { cls: 'onboarding-caption', text: figure.caption });
		}
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
