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
