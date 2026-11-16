import { CONVERTIBLE_SOURCE_EXTENSIONS, type CleanupViewContext, type ConvertibleImage, type ImageConversionProgress, type ImageConversionState, type ImageConversionTarget } from './cleanup-types';
import { formatBytes } from './cleanup-actions';
import { associateCheckbox, createColumnHeader } from './cleanup-a11y';
import { resetArmedConfirmButtons } from './cleanup-confirm-button';

export const CONVERSION_TAB = 'image-convert';

const BLOCKED_REASON_LABELS: Record<string, string> = {
	'alpha-skip': '透明图按设置跳过',
	'code-block-reference': 'Excalidraw 代码块中的图片引用无法安全改写',
	'css-url': 'CSS url() 中的图片引用无法安全改写',
	'html-source': 'picture/source 中的图片引用无法安全改写',
	'residual-reference': '改写后仍有残留引用，已跳过',
	'source-changed': '源文件在转换前已变化，已跳过',
};

/**
 * 把 runner/估算阶段的原因标识转成界面文案。未知标识原样返回，
 * 避免界面出现 `undefined` 或吞掉调用方新增的原因。
 */
export function describeBlockedReason(reason?: string): string {
	const value = reason?.trim();
	if (!value) return '未提供原因';
	return BLOCKED_REASON_LABELS[value] ?? value;
}

const SOURCE_FORMATS: Array<{ value: (typeof CONVERTIBLE_SOURCE_EXTENSIONS)[number]; label: string }> = [
	{ value: 'png', label: 'PNG' },
	{ value: 'jpg', label: 'JPG' },
	{ value: 'webp', label: 'WebP' },
	{ value: 'bmp', label: 'BMP' },
	{ value: 'avif', label: 'AVIF' },
];

const TARGET_FORMATS: Array<{ value: ImageConversionTarget; label: string }> = [
	{ value: 'jpg', label: 'JPG（默认）' },
	{ value: 'webp', label: 'WebP' },
	{ value: 'png', label: 'PNG' },
];

const scannedStates = new WeakSet<ImageConversionState>();
const fallbackSelectionSets = new WeakMap<CleanupViewContext, Set<string>>();
let warnedMissingSelectionSet = false;

type ConvertSelectionHost = CleanupViewContext & {
	convertSelections?: Set<string>;
};

export function conversionSelections(host: CleanupViewContext): Set<string> {
	const explicit = (host as ConvertSelectionHost).convertSelections;
	if (explicit instanceof Set) return explicit;
	let fallback = fallbackSelectionSets.get(host);
	if (!fallback) {
		fallback = new Set<string>();
		fallbackSelectionSets.set(host, fallback);
	}
	if (!warnedMissingSelectionSet) {
		warnedMissingSelectionSet = true;
		console.warn('[cleanup-convert] CleanupViewContext 缺少 convertSelections，已使用界面侧兜底选择集。');
	}
	return fallback;
}

export function clearConversionSelections(host: CleanupViewContext) {
	conversionSelections(host).clear();
}

export function isConversionTab(tab: string): boolean {
	return tab === CONVERSION_TAB;
}

function normalizedSource(value: string): string {
	return value.trim().toLowerCase().replace(/^\./, '');
}

function sourceSelection(state: ImageConversionState): Set<string> {
	return new Set(state.sources.map(normalizedSource));
}

function isBlocked(item: ConvertibleImage): boolean {
	return Boolean(item.blockedReason);
}

function isBusy(state: ImageConversionState): boolean {
	return state.estimating || state.converting;
}

/**
 * 该项是否已完成体积估算。
 * blocked 项要么被跳过、要么因无法安全改写而不会转换，不算「待估算」；
 * 非 blocked 且 newBytes 缺失/为 0/非数字 的都视为还没算出来（界面显示等待估算占位）。
 * newBytes 在类型上仍是必填，但按需估算的改造里渲染层必须容忍缺失，避免把
 * 「未估算」误当成「转换后 0 字节」而误算节省量或误标跳过。
 */
function isEstimated(item: ConvertibleImage): boolean {
	if (isBlocked(item)) return false;
	return typeof item.newBytes === 'number' && Number.isFinite(item.newBytes) && item.newBytes > 0;
}

function savings(item: ConvertibleImage): number {
	if (!isEstimated(item)) return 0;
	return item.oldBytes - item.newBytes;
}

function formatPercent(ratio: number): string {
	if (!Number.isFinite(ratio)) return '0';
	return ratio.toFixed(1).replace(/\.0$/, '');
}

function changePercent(item: ConvertibleImage): number {
	if (!isEstimated(item)) return 0;
	return item.oldBytes > 0 ? Math.abs(savings(item)) / item.oldBytes * 100 : 0;
}

function progressFor(state: ImageConversionState): ImageConversionProgress {
	return state.estimateProgress;
}

function abortConversion(host: CleanupViewContext): (() => void) | undefined {
	const state = host.conversion as ImageConversionState & { abort?: () => void };
	if (typeof state.abort === 'function') return () => state.abort?.();
	if (typeof host.abortEstimate === 'function') return () => host.abortEstimate?.();
	return undefined;
}

function renderSourceFormats(host: CleanupViewContext, container: HTMLElement, warning: HTMLElement, scanButton: HTMLButtonElement) {
	const state = host.conversion;
	const selected = sourceSelection(state);
	const fieldset = container.createEl('fieldset', { cls: 'orphan-cleanup-convert-fieldset' });
	fieldset.createEl('legend', { text: '源格式' });
	const group = fieldset.createDiv({ cls: 'orphan-cleanup-convert-sources' });
	for (const format of SOURCE_FORMATS) {
		const label = group.createEl('label', { cls: 'orphan-cleanup-convert-source' });
		const checkbox = label.createEl('input', { type: 'checkbox' });
		checkbox.checked = selected.has(format.value);
		checkbox.disabled = isBusy(state);
		checkbox.setAttribute('aria-label', `源格式 ${format.label}`);
		label.createSpan({ text: format.label });
		checkbox.addEventListener('change', () => {
			if (checkbox.checked) selected.add(format.value);
			else selected.delete(format.value);
			void host.setConversionConfig({ sources: SOURCE_FORMATS.filter((item) => selected.has(item.value)).map((item) => item.value) });
			scannedStates.delete(state);
			warning.hidden = selected.size > 0;
			scanButton.disabled = isBusy(state) || selected.size === 0;
		});
	}
	warning.hidden = selected.size > 0;
}

function renderControls(host: CleanupViewContext, container: HTMLElement) {
	const state = host.conversion;
	const targetField = container.createEl('label', { cls: 'orphan-cleanup-convert-control' });
	targetField.createSpan({ text: '目标格式' });
	const target = targetField.createEl('select');
	target.disabled = isBusy(state);
	target.setAttribute('aria-label', '目标格式');
	for (const format of TARGET_FORMATS) {
		const option = target.createEl('option', { text: format.label, value: format.value });
		option.selected = format.value === state.target;
	}

	const qualityField = container.createEl('label', { cls: 'orphan-cleanup-convert-control' });
	const qualityHeading = qualityField.createSpan({ text: '质量 ' });
	const qualityValue = qualityHeading.createSpan({ text: String(state.quality), cls: 'orphan-cleanup-convert-quality-value' });
	qualityHeading.createSpan({ text: '%' });
	const quality = qualityField.createEl('input', {
		type: 'range',
		attr: { min: '50', max: '95', step: '1', 'aria-label': '转换质量' },
	});
	quality.value = String(state.quality);

	const syncQuality = () => {
		quality.disabled = isBusy(state) || target.value === 'png';
		qualityValue.toggleClass('is-disabled', quality.disabled);
	};
	target.addEventListener('change', () => {
		void host.setConversionConfig({ target: target.value as ImageConversionTarget });
		scannedStates.delete(state);
		syncQuality();
	});
	quality.addEventListener('input', () => {
		qualityValue.setText(String(Number(quality.value)));
	});
	quality.addEventListener('change', () => {
		void host.setConversionConfig({ quality: Number(quality.value) });
		scannedStates.delete(state);
	});
	syncQuality();

	const alphaFieldset = container.createEl('fieldset', { cls: 'orphan-cleanup-convert-fieldset' });
	alphaFieldset.createEl('legend', { text: '透明图处理' });
	const alphaGroup = alphaFieldset.createDiv({ cls: 'orphan-cleanup-convert-alpha' });
	for (const mode of [
		{ value: 'flatten', label: '白底' },
		{ value: 'skip', label: '跳过' },
	] as const) {
		const label = alphaGroup.createEl('label', { cls: 'orphan-cleanup-convert-alpha-option' });
		const radio = label.createEl('input', { type: 'radio' });
		radio.name = 'orphan-cleanup-convert-alpha';
		radio.value = mode.value;
		radio.checked = state.alpha === mode.value;
		radio.disabled = isBusy(state);
		radio.addEventListener('change', () => {
			if (!radio.checked) return;
			void host.setConversionConfig({ alpha: mode.value });
			scannedStates.delete(state);
		});
		label.createSpan({ text: mode.label });
	}
}

function progressState(host: CleanupViewContext): { phase: 'estimate' | 'convert'; progress: ImageConversionProgress } {
	// 转换进行中优先展示转换进度，否则展示估算进度。
	if (host.conversion.converting) return { phase: 'convert', progress: host.conversion.convertProgress };
	return { phase: 'estimate', progress: progressFor(host.conversion) };
}

export function renderProgress(host: CleanupViewContext, container: HTMLElement) {
	const { phase, progress } = progressState(host);
	const verb = phase === 'convert' ? '转换' : '估算';
	const wrapper = container.createDiv({ cls: 'orphan-cleanup-convert-progress' });
	const text = wrapper.createDiv({ cls: 'orphan-cleanup-convert-progress-text' });
	text.setAttribute('role', 'status');
	text.setAttribute('aria-live', 'polite');
	wrapper.setAttribute('data-phase', phase);
	if (progress.total > 0) {
		const path = progress.currentPath ? ` · ${progress.currentPath}` : '';
		text.setText(`正在${verb} ${progress.processed} / ${progress.total}${path}`);
		const track = wrapper.createDiv({ cls: 'orphan-cleanup-convert-progress-track', attr: { 'aria-hidden': 'true' } });
		const fill = track.createDiv({ cls: 'orphan-cleanup-convert-progress-fill' });
		fill.style.width = `${Math.min(100, Math.max(0, progress.processed / progress.total * 100))}%`;
	} else {
		text.setText(progress.currentPath ? `正在${verb} · ${progress.currentPath}` : `正在${verb}…`);
	}
}

function renderSummary(state: ImageConversionState, container: HTMLElement) {
	// 只有「已估算且未 blocked」的项才有真实的体积变化；未估算项不参与节省量统计，
	// 避免把「还没算」显示成「转换后 0 B」或虚高/虚低的节省。
	const convertable = state.items.filter((item) => !isBlocked(item) && isEstimated(item));
	const blocked = state.items.filter(isBlocked);
	const pending = state.items.filter((item) => !isBlocked(item) && !isEstimated(item)).length;
	const oldBytes = convertable.reduce((total, item) => total + item.oldBytes, 0);
	const newBytes = convertable.reduce((total, item) => total + item.newBytes, 0);
	const saved = oldBytes - newBytes;
	const percent = oldBytes > 0 ? Math.abs(saved) / oldBytes * 100 : 0;
	const verb = saved < 0 ? '预计增加' : '预计节省';
	const summary = container.createDiv({ cls: 'orphan-cleanup-convert-summary' });
	summary.setAttribute('role', 'status');
	summary.setAttribute('aria-live', 'polite');
	const pendingNote = pending > 0 ? ` · ${pending} 张待估算` : '';
	summary.createDiv({ text: `候选 ${state.items.length} 张 · 当前 ${formatBytes(oldBytes)} · 转换后约 ${formatBytes(newBytes)} · ${verb} ${formatBytes(Math.abs(saved))}（${formatPercent(percent)}%）${pendingNote}` });
	if (blocked.length) {
		const reasons = [...new Set(blocked.map((item) => describeBlockedReason(item.blockedReason)))];
		summary.createDiv({
			cls: 'orphan-cleanup-convert-skipped-summary',
			text: `另有 ${blocked.length} 张将跳过${reasons.length ? `（${reasons.join('、')}）` : ''}`,
		});
	}
	if (pending > 0) {
		summary.createDiv({
			cls: 'orphan-cleanup-convert-pending-summary',
			text: `${pending} 张图片尚未估算，点击「扫描并估算」估算这些图片的体积后再选择。`,
		});
	}
}

function renderConfig(host: CleanupViewContext, container: HTMLElement, toolbar: HTMLElement) {
	const state = host.conversion;
	container.createDiv({
		cls: 'orphan-cleanup-convert-warning',
		text: '此页会修改文件：转换成功后原图移入回收站。',
	});
	container.createDiv({
		cls: 'orphan-cleanup-convert-note',
		text: '体积为按源格式与质量推算的预估值，仅供参考；实际大小与透明图处理在转换时精确判定。',
	});

	const config = container.createDiv({ cls: 'orphan-cleanup-convert-config' });
	const noSources = config.createDiv({
		cls: 'orphan-cleanup-convert-note is-warning',
		text: '请至少勾选一种源格式。',
	});
	const scanRow = config.createDiv({ cls: 'orphan-cleanup-convert-scan-row' });
	const scanButton = scanRow.createEl('button', { text: '扫描并估算', cls: 'mod-cta' });
	scanButton.disabled = isBusy(state) || state.sources.length === 0;
	scanButton.addEventListener('click', () => {
		scannedStates.add(state);
		void host.estimateConversions().finally(() => host.renderContents());
	});

	renderSourceFormats(host, config, noSources, scanButton);
	const controls = config.createDiv({ cls: 'orphan-cleanup-convert-controls' });
	renderControls(host, controls);

	if (state.estimating) {
		renderProgress(host, scanRow);
		const abort = abortConversion(host);
		if (abort) {
			const abortButton = scanRow.createEl('button', { text: '中止', cls: 'orphan-cleanup-convert-abort' });
			abortButton.addEventListener('click', abort);
		}
	}
	config.appendChild(scanRow);

	renderSummary(state, container);
	renderSelectionToolbar(host, toolbar);
}

function renderSelectionToolbar(host: CleanupViewContext, toolbar: HTMLElement) {
	const state = host.conversion;
	const selection = conversionSelections(host);
	// 未估算项没有真实体积，不能计入「可节省」；只有已估算且确实省体积的才算。
	const savingsCount = state.items.filter((item) => savings(item) > 0 && !isBlocked(item)).length;
	const selectSavings = toolbar.createEl('button', { text: '全选可节省项', cls: 'orphan-cleanup-convert-select-savings' });
	selectSavings.disabled = isBusy(state) || savingsCount === 0;
	selectSavings.addEventListener('click', () => {
		for (const item of state.items) {
			if (savings(item) > 0 && !isBlocked(item)) selection.add(item.path);
		}
		syncCheckboxes(host);
		updateConversionSelectionSummary(host);
	});
	toolbar.createSpan({ text: `${savingsCount} 张可节省`, cls: 'orphan-cleanup-convert-toolbar-count' });
}

function syncCheckboxes(host: CleanupViewContext) {
	const selection = conversionSelections(host);
	for (const checkbox of Array.from(host.contentEl.querySelectorAll<HTMLInputElement>('.orphan-cleanup-convert-row input[type="checkbox"]'))) {
		if (!checkbox.disabled) checkbox.checked = selection.has(checkbox.dataset.path ?? '');
	}
}

function renderRows(host: CleanupViewContext, content: HTMLElement, toolbar: HTMLElement) {
	const state = host.conversion;
	const emptyText = state.sources.length === 0
		? '请先勾选至少一种源格式。'
		: scannedStates.has(state) || state.estimating
			? '没有找到符合源格式的图片'
			: '点击「扫描并估算」查找可转换图片。';
	if (state.items.length === 0) {
		if (!state.estimating) {
			content.createEl('p', {
				text: emptyText,
				cls: state.sources.length === 0 ? 'orphan-cleanup-convert-note is-warning' : 'orphan-cleanup-empty',
			});
		}
		return;
	}

	const table = content.createEl('table', { cls: 'orphan-cleanup-table orphan-cleanup-convert-table' });
	table.createEl('caption', { text: '图片转换候选列表', cls: 'orphan-cleanup-convert-caption' });
	const header = table.createEl('thead').createEl('tr');
	for (const text of ['选择', '文件', '尺寸', '大小', '变化', '引用', '状态']) createColumnHeader(header, text);
	const body = table.createEl('tbody');
	for (const item of state.items) renderRow(host, body, item);

	toolbar.createSpan({ text: `共 ${state.items.length} 张候选`, cls: 'orphan-cleanup-convert-toolbar-count' });
}

function renderRow(host: CleanupViewContext, body: HTMLElement, item: ConvertibleImage) {
	const state = host.conversion;
	const selection = conversionSelections(host);
	const row = body.createEl('tr', { cls: isBlocked(item) ? 'orphan-cleanup-convert-row is-blocked' : 'orphan-cleanup-convert-row' });
	row.dataset.path = item.path;
	const checkbox = row.createEl('td').createEl('input', { type: 'checkbox' });
	checkbox.dataset.path = item.path;
	checkbox.checked = selection.has(item.path);
	checkbox.disabled = isBusy(state) || isBlocked(item);
	checkbox.setAttribute('aria-label', `选择 ${item.path}`);
	checkbox.addEventListener('change', () => {
		if (checkbox.checked) selection.add(item.path);
		else selection.delete(item.path);
		updateConversionSelectionSummary(host);
	});

	const pathCell = row.createEl('td', { cls: 'orphan-cleanup-convert-path-cell' });
	const link = pathCell.createEl('a', { text: item.path, cls: 'orphan-cleanup-link orphan-cleanup-convert-path' });
	link.addEventListener('click', (event) => {
		event.preventDefault();
		void host.app.workspace.openLinkText(item.path, '', 'tab');
	});
	associateCheckbox(checkbox, [link]);
	const formatBadge = pathCell.createSpan({ cls: 'orphan-cleanup-convert-format' });
	formatBadge.createSpan({ text: normalizedSource(item.extension).toUpperCase(), cls: 'orphan-cleanup-convert-format-source' });
	formatBadge.createSpan({ text: '→', cls: 'orphan-cleanup-convert-format-arrow' });
	formatBadge.createSpan({ text: String(host.conversion.target).toUpperCase(), cls: 'orphan-cleanup-convert-format-target' });

	// 三态：已估算（显示预估体积变化）、blocked（跳过）、未估算（显示占位，等待估算）。
	const blockedRow = isBlocked(item);
	const pendingRow = !blockedRow && !isEstimated(item);
	const hasDimensions = item.width > 0 && item.height > 0;
	row.createEl('td', {
		text: blockedRow || pendingRow || !hasDimensions ? '—' : `${item.width} × ${item.height}`,
		cls: 'orphan-cleanup-convert-dimensions',
	});
	row.createEl('td', {
		text: blockedRow ? `${formatBytes(item.oldBytes)} → —` : pendingRow ? `${formatBytes(item.oldBytes)} → …` : `${formatBytes(item.oldBytes)} → 约 ${formatBytes(item.newBytes)}`,
		cls: 'orphan-cleanup-convert-size',
	});
	const delta = row.createEl('td', { cls: 'orphan-cleanup-convert-delta-cell' });
	if (blockedRow) {
		delta.createSpan({ text: '跳过', cls: 'orphan-cleanup-convert-delta is-skipped' });
	} else if (pendingRow) {
		delta.createSpan({ text: '待估算', cls: 'orphan-cleanup-convert-delta is-pending' });
	} else {
		const saved = savings(item);
		const change = item.oldBytes === 0
			? '—'
			: saved > 0 ? `−${formatPercent(changePercent(item))}%` : saved < 0 ? `+${formatPercent(changePercent(item))}%` : '0%';
		delta.createSpan({
			text: change,
			cls: item.oldBytes === 0 ? 'orphan-cleanup-convert-delta' : saved > 0 ? 'orphan-cleanup-convert-delta is-save' : saved < 0 ? 'orphan-cleanup-convert-delta is-grow' : 'orphan-cleanup-convert-delta',
		});
	}
	const references = row.createEl('td', { text: `引用 ${item.referenceCount} 处`, cls: 'orphan-cleanup-convert-references' });
	references.title = '按引用处数统计，同一篇笔记中的多次引用会分别计数';
	const status = row.createEl('td', { cls: 'orphan-cleanup-convert-status' });
	if (item.hasAlpha) status.createSpan({ text: '透明', cls: 'orphan-cleanup-convert-badge is-alpha' });
	if (item.blockedReason) status.createSpan({ text: `跳过：${describeBlockedReason(item.blockedReason)}`, cls: 'orphan-cleanup-convert-blocked-reason' });
	else if (pendingRow) status.createSpan({ text: '待估算', cls: 'orphan-cleanup-convert-ready' });
	else if (!item.hasAlpha) status.createSpan({ text: '可转换', cls: 'orphan-cleanup-convert-ready' });
}

export function updateConversionSelectionSummary(host: CleanupViewContext, target?: HTMLElement) {
	const summary = target ?? host.contentEl.querySelector<HTMLElement>('.orphan-cleanup-convert-selection-summary');
	if (!summary) return;
	resetArmedConfirmButtons(host.contentEl);
	const selection = conversionSelections(host);
	const selected = host.conversion.items.filter((item) => selection.has(item.path) && !isBlocked(item));
	const saved = selected.reduce((total, item) => total + savings(item), 0);
	const pending = selected.filter((item) => !isEstimated(item)).length;
	if (selected.length === 0) {
		summary.setText('已选：0 张');
	} else if (saved < 0) {
		summary.setText(`已选：${selected.length} 张 · 预计增加 ${formatBytes(Math.abs(saved))}`);
	} else {
		const pendingNote = pending > 0 ? `（${pending} 张待估算）` : '';
		summary.setText(`已选：${selected.length} 张 · 预计节省 ${formatBytes(saved)}${pendingNote}`);
	}
	const start = host.contentEl.querySelector<HTMLButtonElement>('.orphan-cleanup-convert-start');
	if (start) {
		if (host.conversion.converting) start.setText('转换中…');
		start.disabled = selected.length === 0 || isBusy(host.conversion);
	}
}

export function renderConversionList(host: CleanupViewContext) {
	const list = host.contentEl.createDiv({ cls: 'orphan-cleanup-list' });
	const toolbar = list.createDiv({ cls: 'orphan-cleanup-toolbar orphan-cleanup-convert-toolbar' });
	const content = list.createDiv({ cls: 'orphan-cleanup-scroll orphan-cleanup-convert-content' });
	renderConfig(host, content, toolbar);
	renderRows(host, content, toolbar);
}
