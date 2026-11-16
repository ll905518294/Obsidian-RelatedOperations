let sequence = 0;

export function nextListElementId(prefix: string): string {
	sequence += 1;
	return `orphan-cleanup-${prefix}-${sequence}`;
}

export function associateCheckbox(checkbox: HTMLElement, labels: HTMLElement[]): void {
	const ids = labels.map((label) => {
		const id = nextListElementId('label');
		label.setAttribute('id', id);
		return id;
	});
	checkbox.setAttribute('aria-labelledby', ids.join(' '));
}

export function makePreviewTrigger(image: HTMLElement, label: string, onActivate: () => void): void {
	image.setAttribute('role', 'button');
	image.setAttribute('tabindex', '0');
	image.setAttribute('aria-haspopup', 'dialog');
	image.setAttribute('aria-label', label);
	image.addEventListener('click', onActivate);
	image.addEventListener('keydown', (event: KeyboardEvent) => {
		if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
		event.preventDefault();
		onActivate();
	});
}

export function createColumnHeader(parent: HTMLElement, text: string): HTMLElement {
	const header = parent.createEl('th', { text });
	header.setAttribute('scope', 'col');
	return header;
}

/**
 * Obsidian 的 Modal 只负责挂载与关闭，不会声明对话框语义；
 * 这里统一补 role/aria-modal，并用 aria-labelledby 指向标题，
 * 让屏幕阅读器播报“对话框 + 标题”而不是只读一堆正文。
 */
export function markDialog(modalEl: HTMLElement, titleEl: HTMLElement): void {
	modalEl.setAttribute('role', 'dialog');
	modalEl.setAttribute('aria-modal', 'true');
	const id = nextListElementId('dialog-title');
	titleEl.setAttribute('id', id);
	modalEl.setAttribute('aria-labelledby', id);
}
