export interface CleanupViewSnapshot {
	tag: string;
	key: string;
	index: number;
	scrollTop: number;
	scrollTarget: 'scroll' | 'root';
}

export interface FocusSnapshot {
	key: string;
	tag: string;
	index: number;
}

function focusKey(element: Element): string {
	const aria = element.getAttribute?.('aria-label');
	if (aria) return aria;
	const tab = element.getAttribute?.('data-tab') ?? (element as HTMLElement).dataset?.tab;
	if (tab) return `tab:${tab}`;
	return (element.textContent ?? '').trim();
}

function canFocus(element: Element | null): element is HTMLElement {
	return !!element && typeof (element as HTMLElement).focus === 'function';
}

function captureFocus(root: HTMLElement): FocusSnapshot | null {
	const active = root.ownerDocument?.activeElement;
	if (!active || active === root || !root.contains(active) || !canFocus(active)) return null;
	const tag = active.tagName;
	const key = focusKey(active);
	const peers = Array.from(root.querySelectorAll<HTMLElement>(tag)).filter((element) => focusKey(element) === key);
	const index = peers.indexOf(active);
	return { tag, key, index: index >= 0 ? index : 0 };
}

function restoreFocus(root: HTMLElement, snapshot: FocusSnapshot | null): void {
	if (!snapshot) return;
	const peers = Array.from(root.querySelectorAll<HTMLElement>(snapshot.tag)).filter((element) => focusKey(element) === snapshot.key);
	const target = peers[snapshot.index] ?? peers[0];
	target?.focus?.({ preventScroll: true });
}

export function withFocusPreserved(root: HTMLElement, render: () => void): void {
	const snapshot = captureFocus(root);
	render();
	restoreFocus(root, snapshot);
}

export function captureViewSnapshot(contentEl: HTMLElement): CleanupViewSnapshot | null {
	const active = contentEl.ownerDocument?.activeElement;
	let tag = '';
	let key = '';
	let index = 0;
	if (active && active !== contentEl && contentEl.contains(active) && canFocus(active)) {
		tag = active.tagName;
		key = focusKey(active);
		const peers = Array.from(contentEl.querySelectorAll<HTMLElement>(tag)).filter((element) => focusKey(element) === key);
		const found = peers.indexOf(active);
		index = found >= 0 ? found : 0;
	}
	const scroller = contentEl.querySelector<HTMLElement>('.orphan-cleanup-scroll');
	const scrollTop = (scroller ?? contentEl).scrollTop;
	if (!tag && !scrollTop) return null;
	return { tag, key, index, scrollTop, scrollTarget: scroller ? 'scroll' : 'root' };
}

export function restoreViewSnapshot(contentEl: HTMLElement, snapshot: CleanupViewSnapshot, restoreScroll: boolean): void {
	if (snapshot.tag) {
		const peers = Array.from(contentEl.querySelectorAll<HTMLElement>(snapshot.tag)).filter((element) => focusKey(element) === snapshot.key);
		const target = peers[snapshot.index] ?? peers[0];
		target?.focus?.({ preventScroll: true });
	}
	if (!restoreScroll || snapshot.scrollTop <= 0) return;
	const scroller = snapshot.scrollTarget === 'scroll' ? contentEl.querySelector<HTMLElement>('.orphan-cleanup-scroll') : contentEl;
	if (scroller) scroller.scrollTop = snapshot.scrollTop;
}
