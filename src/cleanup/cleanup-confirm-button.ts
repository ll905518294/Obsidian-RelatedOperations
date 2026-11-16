export const CONFIRM_ARM_TIMEOUT_MS = 3000;

const ARMED_CLASS = 'is-armed-confirm';
const CONFIRM_LABEL = '确认删除';
const CONFIRM_HINT = '再次点击确认删除';

export interface ConfirmButtonLabels {
	confirm?: string;
	hint?: string;
}

export interface ConfirmButtonOptions {
	timeoutMs?: number;
	labels?: ConfirmButtonLabels;
}

export interface ConfirmButtonHandle {
	reset(): void;
}

function isConfirmButtonOptions(value: ConfirmButtonOptions | ConfirmButtonLabels): value is ConfirmButtonOptions {
	return 'labels' in value || 'timeoutMs' in value;
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

function writeAttribute(button: HTMLButtonElement, name: string, value: string | null): void {
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
 * The first click only arms the button (text becomes the configured confirm
 * label, default 「确认删除」; warning styling is applied and a screen-reader
 * hint explains the second click). The
 * second click within the timeout runs the callback. Arming is reset by the
 * timeout, by moving focus away, or by `resetArmedConfirmButtons` when the
 * selection changes. Rebuilding the button naturally starts unarmed again.
 */
export function requireSecondClick(
	button: HTMLButtonElement,
	onConfirm: () => void | Promise<void>,
	options: ConfirmButtonOptions | ConfirmButtonLabels = {},
): ConfirmButtonHandle {
	// Icon/rich-content buttons keep their SVG (or other) child nodes across
	// the arming round-trip. Obsidian's setText assigns `textContent`, which
	// would wipe those children; snapshot them so reset can put them back.
	const originalChildNodes = button.childNodes ? Array.from(button.childNodes) : [];
	const originalText = button.textContent ?? '';
	const originalClassName = button.className;
	const originalTitle = readAttribute(button, 'title');
	const originalAriaLabel = readAttribute(button, 'aria-label');
	const originalAriaDescription = readAttribute(button, 'aria-description');
	let armed = false;
	let timer = 0;
	const optionsShape = isConfirmButtonOptions(options);
	const labels = optionsShape ? options.labels : options;
	const timeoutMs = optionsShape ? options.timeoutMs : undefined;
	const confirmLabel = labels?.confirm ?? CONFIRM_LABEL;
	const confirmHint = labels?.hint ?? CONFIRM_HINT;

	const restoreContent = () => {
		if (originalChildNodes.length > 0) {
			// Restore the child nodes exactly as they were before arming.
			const empty = (button as { empty?: () => void }).empty;
			if (typeof empty === 'function') empty.call(button);
			else button.textContent = '';
			for (const node of originalChildNodes) button.appendChild(node);
			return;
		}
		// Plain text button: keep the original label.
		button.setText(originalText);
	};

	const reset = () => {
		if (timer) {
			window.clearTimeout(timer);
			timer = 0;
		}
		if (!armed) return;
		armed = false;
		restoreContent();
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
		button.setText(confirmLabel);
		button.addClass(ARMED_CLASS, 'mod-warning');
		// Icon-only buttons derive their accessible name from aria-label, so the
		// text swap alone would leave a screen reader announcing the old label.
		// Text buttons are named by their text and must not gain an aria-label.
		if (originalAriaLabel !== null) writeAttribute(button, 'aria-label', confirmLabel);
		// `title` carries the armed name for the hover tooltip; the second-click
		// hint lives only in aria-description so it is not announced twice.
		writeAttribute(button, 'title', confirmLabel);
		writeAttribute(button, 'aria-description', confirmHint);
		timer = window.setTimeout(reset, timeoutMs ?? CONFIRM_ARM_TIMEOUT_MS);
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
