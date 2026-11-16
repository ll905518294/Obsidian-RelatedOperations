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
