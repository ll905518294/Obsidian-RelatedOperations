import { App, TFolder } from 'obsidian';

let folderInputSequence = 0;

export function addFolderInput(
	app: App,
	container: HTMLElement,
	label: string,
	value: string,
	className: string,
	onInput: (value: string) => void,
	onCommit?: (value: string) => void,
) {
	const field = container.createDiv({ cls: 'related-operations-folder-field' });
	const inputId = `related-operations-folder-input-${folderInputSequence++}`;
	const labelEl = field.createEl('label', { text: label });
	labelEl.setAttribute('for', inputId);
	const input = field.createEl('input', { type: 'text', value });
	input.id = inputId;
	input.addClass(className);
	const suggestions = field.createDiv({ cls: 'related-operations-folder-suggestions' });
	input.addEventListener('focus', () => {
		populateFolderSuggestions(app, suggestions, input);
		suggestions.addClass('is-visible');
	});
	input.addEventListener('input', () => {
		onInput(input.value);
		populateFolderSuggestions(app, suggestions, input);
		suggestions.addClass('is-visible');
	});
	const commit = () => {
		if (!onCommit) return;
		const next = input.value;
		// Defer the rebuild so a click on a toolbar/action button that blurred
		// this field is delivered before the list is replaced.
		window.setTimeout(() => onCommit(next), 0);
	};
	input.addEventListener('change', commit);
	input.addEventListener('blur', () => {
		window.setTimeout(() => suggestions.removeClass('is-visible'), 150);
	});
	populateFolderSuggestions(app, suggestions, input);
}

export function populateFolderSuggestions(app: App, container: HTMLElement, input: HTMLInputElement) {
	container.empty();
	const values = app.vault.getAllLoadedFiles()
		.filter((file): file is TFolder => file instanceof TFolder)
		.map((folder) => folder.path)
		.filter((path) => path.toLowerCase().includes(input.value.trim().toLowerCase()));
	for (const value of values.sort()) {
		const option = container.createEl('button', { text: value, cls: 'related-operations-folder-suggestion' });
		option.type = 'button';
		option.addEventListener('mousedown', (event) => event.preventDefault());
		option.addEventListener('click', () => {
			input.value = value;
			input.dispatchEvent(new Event('input'));
			input.dispatchEvent(new Event('change'));
			container.removeClass('is-visible');
		});
	}
}
