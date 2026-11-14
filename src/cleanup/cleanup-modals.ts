import { App, Modal, TFile, setIcon } from 'obsidian';
import { openInSystemFolder } from './cleanup-actions';
export class CleanupConfirmationModal extends Modal {
	private resolver?: (confirmed: boolean) => void;
	private settled = false;

	constructor(app: App, private readonly imageCount: number, private readonly attachmentCount: number, private readonly emptyFileCount: number, private readonly folderCount: number) {
		super(app);
	}

	waitForConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolver = resolve;
			this.open();
		});
	}

	onOpen() {
		this.titleEl.setText('确认移入回收站');
		this.contentEl.createEl('p', { text: `即将移入 Obsidian 回收站：${this.imageCount} 张图片、${this.attachmentCount} 个附件、${this.emptyFileCount} 个空文件、${this.folderCount} 个文件夹。` });
		this.contentEl.createEl('p', { text: '这不会永久删除文件，可在 Obsidian 回收站中恢复。', cls: 'orphan-cleanup-warning' });
		const actions = this.contentEl.createDiv({ cls: 'orphan-cleanup-actions' });
		const confirm = actions.createEl('button', { text: '确认移入回收站', cls: 'mod-cta' });
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

export class CreateNotesConfirmationModal extends Modal {
	private resolver?: (confirmed: boolean) => void;
	private settled = false;
	constructor(app: App, private readonly count: number) { super(app); }
	waitForConfirmation() { return new Promise<boolean>((resolve) => { this.resolver = resolve; this.open(); }); }
	onOpen() {
		this.titleEl.setText('确认创建笔记');
		this.contentEl.createEl('p', { text: `将创建 ${this.count} 个空白 Markdown 笔记，并自动创建缺失父目录。` });
		this.contentEl.createEl('p', { text: '已有文件、非法路径和创建失败的目标会跳过或报告。', cls: 'orphan-cleanup-warning' });
		const actions = this.contentEl.createDiv({ cls: 'orphan-cleanup-actions' });
		actions.createEl('button', { text: '确认创建', cls: 'mod-cta' }).addEventListener('click', () => this.finish(true));
		actions.createEl('button', { text: '取消' }).addEventListener('click', () => this.finish(false));
	}
	onClose() { this.contentEl.empty(); if (!this.settled) this.finish(false); }
	private finish(value: boolean) { if (this.settled) return; this.settled = true; this.resolver?.(value); this.close(); }
}

export class RemoveBrokenLinksConfirmationModal extends Modal {
	private resolver?: (confirmed: boolean) => void;
	private settled = false;

	constructor(app: App, private readonly linkCount: number, private readonly sourceCount: number) {
		super(app);
	}

	waitForConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolver = resolve;
			this.open();
		});
	}

	onOpen() {
		this.titleEl.setText('确认移除链接');
		this.contentEl.createEl('p', { text: `即将修改 ${this.sourceCount} 篇笔记，移除 ${this.linkCount} 条失效图片链接。` });
		this.contentEl.createEl('p', { text: '这会直接修改 Markdown 内容，不会移入回收站。', cls: 'orphan-cleanup-warning' });
		const actions = this.contentEl.createDiv({ cls: 'orphan-cleanup-actions' });
		const confirm = actions.createEl('button', { text: '确认移除链接', cls: 'mod-cta' });
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

export class ConvertNativeLinksConfirmationModal extends Modal {
	private resolver?: (confirmed: boolean) => void;
	private settled = false;
	constructor(app: App, private readonly count: number) { super(app); }
	waitForConfirmation() { return new Promise<boolean>((resolve) => { this.resolver = resolve; this.open(); }); }
	onOpen() {
		this.titleEl.setText('确认转换图片链接');
		this.contentEl.createEl('p', { text: `即将转换 ${this.count} 条原生图片链接。` });
		this.contentEl.createEl('p', { text: '尺寸参数和无法解析的链接会跳过；已转换内容可用编辑历史撤销。', cls: 'orphan-cleanup-warning' });
		const actions = this.contentEl.createDiv({ cls: 'orphan-cleanup-actions' });
		actions.createEl('button', { text: '确认转换', cls: 'mod-cta' }).addEventListener('click', () => this.finish(true));
		actions.createEl('button', { text: '取消' }).addEventListener('click', () => this.finish(false));
	}
	onClose() { this.contentEl.empty(); if (!this.settled) { this.settled = true; this.resolver?.(false); } }
	private finish(value: boolean) { if (this.settled) return; this.settled = true; this.resolver?.(value); this.close(); }
}

export class ImagePreviewModal extends Modal {
	private index: number;
	private imageEl!: HTMLImageElement;
	private pathEl!: HTMLElement;
	private previousButton!: HTMLButtonElement;
	private nextButton!: HTMLButtonElement;

	constructor(
		app: App,
		private readonly files: TFile[],
		index: number,
		private readonly onDelete: (file: TFile) => Promise<void>,
	) {
		super(app);
		this.index = index;
	}

	onOpen() {
		this.modalEl.addClass('orphan-cleanup-preview-dialog');
		this.contentEl.addClass('orphan-cleanup-preview-modal');
		const frame = this.contentEl.createDiv({ cls: 'orphan-cleanup-preview-frame' });
		this.imageEl = frame.createEl('img', { cls: 'orphan-cleanup-full-preview is-auto-fit' });
		this.imageEl.addEventListener('error', () => frame.addClass('is-error'));
		this.pathEl = this.contentEl.createEl('p', { cls: 'orphan-cleanup-preview-path' });
		const actions = this.contentEl.createDiv({ cls: 'orphan-cleanup-preview-actions' });
		this.previousButton = actions.createEl('button', { text: '上一张' });
		this.previousButton.addEventListener('click', () => this.navigate(-1));
		this.nextButton = actions.createEl('button', { text: '下一张' });
		this.nextButton.addEventListener('click', () => this.navigate(1));
		const open = actions.createEl('button', { text: '打开文件' });
		open.addEventListener('click', () => void this.openCurrentFile());
		const openFolder = actions.createEl('button', { cls: 'orphan-cleanup-open-folder' });
		openFolder.title = '打开所在文件夹';
		openFolder.setAttribute('aria-label', '打开所在文件夹');
		setIcon(openFolder, 'folder-open');
		openFolder.addEventListener('click', () => this.openCurrentFolder());
		const remove = actions.createEl('button', { text: '删除', cls: 'mod-warning' });
		remove.addEventListener('click', () => {
			const file = this.files[this.index];
			if (file) void this.trashCurrent(file);
		});
		this.scope.register(null, 'ArrowLeft', () => { this.navigate(-1); return false; });
		this.scope.register(null, 'ArrowRight', () => { this.navigate(1); return false; });
		this.updatePreview();
	}

	onClose() {
		this.contentEl.empty();
	}

	private navigate(offset: number) {
		const nextIndex = this.index + offset;
		if (nextIndex < 0 || nextIndex >= this.files.length) return;
		this.index = nextIndex;
		this.updatePreview();
	}

	private updatePreview() {
		const file = this.files[this.index];
		if (!file) return this.close();
		this.titleEl.setText(`${file.name}（${this.index + 1}/${this.files.length}）`);
		this.imageEl.alt = file.name;
		this.imageEl.parentElement?.removeClass('is-error');
		this.imageEl.src = this.app.vault.getResourcePath(file);
		this.pathEl.setText(file.path);
		this.previousButton.disabled = this.index === 0;
		this.nextButton.disabled = this.index === this.files.length - 1;
	}

	private async openCurrentFile() {
		const file = this.files[this.index];
		if (file) await this.app.workspace.openLinkText(file.path, '', 'tab');
	}

	private openCurrentFolder() {
		const file = this.files[this.index];
		if (file) openInSystemFolder(this.app, file);
	}

	private async trashCurrent(file: TFile) {
		await this.onDelete(file);
		this.close();
	}
}
