// Links created with only a click listener are invisible to keyboard users:
// an <a> without href is not focusable and does not fire click on Enter/Space.
// Centralize the button semantics so every note link behaves the same.
export function makeNoteLinkActivatable(link: HTMLAnchorElement, activate: () => void) {
	link.setAttribute('role', 'button');
	link.setAttribute('tabindex', '0');
	link.addEventListener('click', (event) => {
		event.preventDefault();
		activate();
	});
	link.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		activate();
	});
}
