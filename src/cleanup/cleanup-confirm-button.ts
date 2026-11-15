export const CONFIRM_ARM_TIMEOUT_MS = 3000;

const ARMED_CLASS = 'is-armed-confirm';

export interface ConfirmButtonHandle {
	reset(): void;
}

const resetsByButton = new WeakMap<HTMLButtonElement, () => void>();

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
	const originalTitle = button.title;
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
		button.setAttribute('title', originalTitle);
		button.setAttribute('aria-description', '');
	};

	const onClick = () => {
		if (armed) {
			reset();
			void onConfirm();
			return;
		}
		armed = true;
		button.setText('确认删除');
		button.addClass(ARMED_CLASS, 'mod-warning');
		button.setAttribute('title', '再次点击确认删除');
		button.setAttribute('aria-description', '再次点击确认删除');
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
