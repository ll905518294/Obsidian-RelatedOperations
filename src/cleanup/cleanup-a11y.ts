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

/**
 * 复合控件内部使用 roving tabindex：
 * 整组预览图只占一个 Tab 停靠点，方向键在成员之间移动。
 * 否则上百张预览图各有 tabindex=0，键盘用户按 Tab 永远穿不过列表。
 */
export function applyRovingTabindex(container: HTMLElement, selector: string): void {
	const items = Array.from(container.querySelectorAll<HTMLElement>(selector));
	if (!items.length) return;
	const activate = (active: HTMLElement) => {
		for (const item of items) item.setAttribute('tabindex', item === active ? '0' : '-1');
	};
	activate(items[0]!);
	// 事件委托到容器：成员被重绘后不需要重新绑定监听。
	container.addEventListener('keydown', (event) => {
		const index = items.indexOf(event.target as HTMLElement);
		if (index < 0) return;
		let next = index;
		switch (event.key) {
			case 'ArrowRight':
			case 'ArrowDown':
				next = Math.min(items.length - 1, index + 1);
				break;
			case 'ArrowLeft':
			case 'ArrowUp':
				next = Math.max(0, index - 1);
				break;
			case 'Home':
				next = 0;
				break;
			case 'End':
				next = items.length - 1;
				break;
			default:
				return;
		}
		event.preventDefault();
		activate(items[next]!);
		items[next]!.focus({ preventScroll: true });
	});
}

/**
 * 记住打开弹窗前的焦点元素，弹窗关闭后还回去。
 * Obsidian 的 Modal 关闭时只把容器摘掉，不会把焦点还给触发按钮，
 * 键盘用户会被丢回文档开头。
 */
export function rememberFocusOrigin(): (() => void) | undefined {
	const active = typeof document === 'undefined' ? null : document.activeElement;
	if (!active || typeof (active as HTMLElement).focus !== 'function') return undefined;
	const origin = active as HTMLElement;
	return () => {
		if (origin.isConnected === false) return;
		origin.focus({ preventScroll: true });
	};
}

const liveRegions = new WeakMap<HTMLElement, HTMLElement>();
const lastAnnouncements = new WeakMap<HTMLElement, string>();

/**
 * 状态播报统一走一个 role=status 区域。
 * 区域在每次重绘时重建，只有文案真正变化才写入，
 * 否则同一个进度会被屏幕阅读器反复朗读。
 */
export function ensureLiveRegion(root: HTMLElement): HTMLElement | undefined {
	const existing = liveRegions.get(root);
	if (existing && existing.parentElement === root) return existing;
	// 宿主容器在测试或降级场景下可能没有 Obsidian 的 DOM 扩展，此时跳过 live 区域。
	if (typeof root.createDiv !== 'function') return undefined;
	const region = root.createDiv({ cls: 'orphan-cleanup-live-status' });
	region.setAttribute('role', 'status');
	region.setAttribute('aria-live', 'polite');
	region.setAttribute('aria-atomic', 'true');
	liveRegions.set(root, region);
	return region;
}

export function announceStatus(root: HTMLElement, message: string): void {
	if (!message) return;
	if (lastAnnouncements.get(root) === message) return;
	const region = ensureLiveRegion(root);
	if (!region) return;
	lastAnnouncements.set(root, message);
	region.setText(message);
}

/** 只在文本真的变了才写 DOM，避免无意义的重绘与重复播报。 */
export function setTextIfChanged(element: HTMLElement | null | undefined, text: string): boolean {
	if (!element) return false;
	if (element.textContent === text) return false;
	element.setText(text);
	return true;
}
