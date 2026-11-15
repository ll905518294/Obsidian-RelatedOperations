export const CONFIRM_ARM_TIMEOUT_MS = 3000;

const ARMED_CLASS = 'is-armed-confirm';
const CONFIRM_LABEL = '确认删除';
const CONFIRM_HINT = '再次点击确认删除';

export interface ConfirmButtonHandle {
	reset(): void;
}

const resetsByButton = new WeakMap<HTMLButtonElement, () => void>();

type AttributeCapable = {
	getAttribute?: (name: string) => string | null;
	removeAttribute?: (name: string) => void;
};

function readAttribute(button: HTMLButtonElement, name: string): string | null {
	const getter = (button as AttributeCapable).getAttribute;
	return typeof getter === 'function' ? getter.call(button, name) : null;
}

function writeAttribute(button: HTMLButtonElement, name: string, value: string | null) {
	if (value === null) {
		const remover = (button as AttributeCapable).removeAttribute;
		if (typeof remover === 'function') remover.call(button, name);
		else button.setAttribute(name, '');
		return;
	}
	button.setAttribute(name, value);
}

/**
 * Two-click confirmation for destructive buttons.
 *
 * The first click only arms the button (text becomes 「确认删除」, warning
 * styling is applied, a screen-reader hint explains the second click). The
 * second click within the timeout runs the callback. Arming is reset by the
 * timeout, by moving focus away, or by `resetArmedConfirmButtons` when the
 * selection changes. Rebuilding the button naturally starts unarmed again.
 */
export function requireSecondClick(
	button: HTMLButtonElement,
	onConfirm: () => unknown,
	options: { timeoutMs?: number } = {},
): ConfirmButtonHandle {
	const originalText = button.textContent ?? '';
	const originalClassName = button.className;
	const originalTitle = readAttribute(button, 'title');
	const originalAriaLabel = readAttribute(button, 'aria-label');
	const originalAriaDescription = readAttribute(button, 'aria-description');
	let armed = false;
	let timer = 0;

	const reset = () => {
		if (timer) {
			window.clearTimeout(timer);
			timer = 0;
		}
		if (!armed) return;
		armed = false;
		button.setText(originalText);
		button.className = originalClassName;
		// Put back exactly what was there before arming: an attribute that did
		// not exist must be removed again, not left as an empty string.
		writeAttribute(button, 'title', originalTitle);
		writeAttribute(button, 'aria-label', originalAriaLabel);
		writeAttribute(button, 'aria-description', originalAriaDescription);
	};

	const onClick = () => {
		if (armed) {
			reset();
			void onConfirm();
			return;
		}
		armed = true;
		button.setText(CONFIRM_LABEL);
		button.addClass(ARMED_CLASS, 'mod-warning');
		// Icon-only buttons derive their accessible name from aria-label, so the
		// text swap alone would leave a screen reader announcing the old label.
		// Text buttons are named by their text and must not gain an aria-label.
		if (originalAriaLabel !== null) writeAttribute(button, 'aria-label', CONFIRM_LABEL);
		// `title` carries the armed name for the hover tooltip; the second-click
		// hint lives only in aria-description so it is not announced twice.
		writeAttribute(button, 'title', CONFIRM_LABEL);
		writeAttribute(button, 'aria-description', CONFIRM_HINT);
		timer = window.setTimeout(reset, options.timeoutMs ?? CONFIRM_ARM_TIMEOUT_MS);
	};

	button.addEventListener('click', onClick);
	button.addEventListener('blur', reset);
	resetsByButton.set(button, reset);
	return { reset };
}

export function resetArmedConfirmButtons(root: ParentNode) {
	for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>(`.${ARMED_CLASS}`))) {
		resetsByButton.get(button)?.();
	}
}
