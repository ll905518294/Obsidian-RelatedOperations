import { setIcon } from 'obsidian';
import { CLEANUP_CATEGORIES, type CleanupViewContext, type ScanCategoryTab } from './cleanup-types';
import { categoryCount, categoryStatus, categoryTotal, formatScanDuration, scanPercent, tabEntries } from './cleanup-selectors';
import { nextListElementId } from './cleanup-a11y';
export { categoryStatus, tabEntries };

/*
 * 同一个视图可以出现在多个 leaf 中，帮助内容的 id 必须按容器区分；
 * 按钮的 aria-controls 与帮助容器的 id 由同一函数生成，保证指向同一个元素。
 */
const helpPanelIds = new WeakMap<HTMLElement, string>();

function helpPanelId(view: CleanupViewContext): string {
	const existing = helpPanelIds.get(view.contentEl);
	if (existing) return existing;
	const id = nextListElementId('help');
	helpPanelIds.set(view.contentEl, id);
	return id;
}

export function updateScanProgress(view: CleanupViewContext) {
	const { stage, currentFile } = view.scanProgress;
	const percent = scanPercent(view.scanning, view.scanStages.length, view.scanProgress);
	const label = view.scanStages[stage]?.label ?? '扫描完成';
	view.contentEl.querySelector<HTMLElement>('.orphan-cleanup-dashboard-progress-bar')?.style.setProperty('width', `${percent}%`);
	view.contentEl.querySelector<HTMLElement>('.orphan-cleanup-dashboard-progress-meta')?.setText(view.scanning ? `${label} · ${percent}% · 用时 ${formatScanDuration(view.scanElapsedMs)}` : '扫描完成');
	view.contentEl.querySelector<HTMLElement>('.orphan-cleanup-dashboard-current-file')?.setText(currentFile ? `当前文件：${currentFile}` : (view.scanning ? '正在准备扫描…' : '扫描结果已更新'));
	view.contentEl.querySelector<HTMLElement>('.orphan-cleanup-dashboard-progress-bar-wrap')?.setAttribute('aria-valuenow', String(percent));
	for (const item of Array.from(view.contentEl.querySelectorAll<HTMLElement>('.orphan-cleanup-dashboard-item[data-tab]'))) {
		const tab = item.dataset.tab as ScanCategoryTab;
		const completed = view.scannedTabs.has(tab);
		const current = view.scanning && !completed && categoryScanStage(tab) === stage;
		item.toggleClass('is-scanning', current);
		item.querySelector<HTMLElement>('.orphan-cleanup-dashboard-item-status')?.setText(view.scanning
			? completed ? `已完成 · ${categoryCount(view.candidates, tab)} 项` : current ? '正在扫描…' : '等待扫描'
			: categoryStatus(categoryCount(view.candidates, tab), completed, false, view.dirtyTabs.has(tab)));
	}
	const ring = view.contentEl.querySelector<HTMLElement>('.orphan-cleanup-dashboard-progress-ring');
	if (ring) ring.style.setProperty('--scan-progress', `${view.scanning ? percent : view.scannedTabs.size / CLEANUP_CATEGORIES.length * 100}%`);
}

function categoryScanStage(tab: ScanCategoryTab): number {
	return tab === 'images' || tab === 'attachments' ? 2 : tab === 'empty-files' || tab === 'folders' ? 3 : tab === 'duplicates' ? 5 : 4;
}

export function renderOverview(view: CleanupViewContext) {
	const home = view.contentEl.createDiv({ cls: 'orphan-cleanup-home orphan-cleanup-dashboard' });
	if (view.scanning) home.addClass('is-scanning');
	const total = categoryTotal(view.candidates);
	const scanned = view.scannedTabs.size;
	const stale = CLEANUP_CATEGORIES.filter((category) => view.scannedTabs.has(category.tab) && view.dirtyTabs.has(category.tab)).length;
	const header = home.createDiv({ cls: 'orphan-cleanup-home-header' });
	const heading = header.createDiv({ cls: 'orphan-cleanup-home-heading' });
	heading.createDiv({ text: 'Vault 健康概览', cls: 'orphan-cleanup-home-eyebrow' });
	heading.createEl('h2', { text: view.scanning ? '正在检查资料库' : total ? '需要你的注意' : scanned < CLEANUP_CATEGORIES.length || view.dirtyTabs.size ? '等待检查资料库' : '资料库状态良好' });
	heading.createEl('p', { text: view.scanning ? '扫描会在当前页面持续进行，结果将直接显示在对应模块。' : '扫描仅在本地进行，不会修改任何文件。', cls: 'orphan-cleanup-home-subtitle' });
	const scanAll = header.createEl('button', { text: view.scanning ? '扫描中…' : view.hasScanned ? '重新扫描全部' : '开始扫描', cls: 'mod-cta orphan-cleanup-scan-all' });
	scanAll.disabled = view.scanning || view.scanningTabs.size > 0;
	scanAll.addEventListener('click', () => void view.scan());

	const hero = header.createDiv({ cls: 'orphan-cleanup-dashboard-hero' });
	const heroCopy = hero.createDiv({ cls: 'orphan-cleanup-dashboard-hero-copy' });
	heroCopy.createDiv({ text: view.scanning ? '扫描中的现有结果' : '当前待处理', cls: 'orphan-cleanup-dashboard-label' });
	heroCopy.createDiv({ text: String(total), cls: 'orphan-cleanup-dashboard-total' });
	heroCopy.createDiv({ text: `${scanned} / ${CLEANUP_CATEGORIES.length} 个分类已扫描${stale ? ` · ${stale} 类待复核` : ''}`, cls: 'orphan-cleanup-dashboard-meta' });
	if (view.scanning) {
		const progress = heroCopy.createDiv({ cls: 'orphan-cleanup-dashboard-progress-bar-wrap' });
		progress.setAttribute('role', 'progressbar');
		progress.setAttribute('aria-label', '整体扫描进度（按阶段）');
		progress.setAttribute('aria-valuemin', '0');
		progress.setAttribute('aria-valuemax', '100');
		progress.createDiv({ cls: 'orphan-cleanup-dashboard-progress-bar' });
		heroCopy.createDiv({ cls: 'orphan-cleanup-dashboard-progress-meta' });
		heroCopy.createDiv({ cls: 'orphan-cleanup-dashboard-current-file' });
	}
	const progress = hero.createDiv({ cls: 'orphan-cleanup-dashboard-progress' });
	progress.createDiv({ cls: 'orphan-cleanup-dashboard-progress-ring' }).createSpan({ text: `${scanned}/${CLEANUP_CATEGORIES.length}` });

	renderScanError(view, home);

	const priority = CLEANUP_CATEGORIES
		.filter((category) => view.scanning || categoryCount(view.candidates, category.tab) > 0)
		.sort((a, b) => view.scanning
			? categoryScanStage(a.tab) - categoryScanStage(b.tab)
			: categoryCount(view.candidates, b.tab) - categoryCount(view.candidates, a.tab));
	const prioritySection = home.createDiv({ cls: 'orphan-cleanup-dashboard-section' });
	const priorityHeading = prioritySection.createDiv({ cls: 'orphan-cleanup-dashboard-section-heading' });
	priorityHeading.createEl('h3', { text: view.scanning ? '扫描进度' : '优先处理' });
	priorityHeading.createSpan({ text: view.scanning ? '模块完成后会直接更新状态' : priority.length ? '按问题数量排序' : '没有待处理项目' });
	const priorityGrid = prioritySection.createDiv({ cls: 'orphan-cleanup-priority-grid' });
	if (priority.length) for (const category of priority) renderDashboardCategory(view, priorityGrid, category, true);
	else priorityGrid.createDiv({ text: '所有已检查分类都很干净。', cls: 'orphan-cleanup-dashboard-empty' });

	const healthy = view.scanning ? [] : CLEANUP_CATEGORIES.filter((category) => view.scannedTabs.has(category.tab) && categoryCount(view.candidates, category.tab) === 0 && !view.dirtyTabs.has(category.tab));
	if (healthy.length) {
		const healthySection = home.createDiv({ cls: 'orphan-cleanup-dashboard-section orphan-cleanup-dashboard-healthy' });
		const healthyHeading = healthySection.createDiv({ cls: 'orphan-cleanup-dashboard-section-heading' });
		healthyHeading.createEl('h3', { text: '已检查' });
		healthyHeading.createSpan({ text: `${healthy.length} 个分类没有问题` });
		const healthyList = healthySection.createDiv({ cls: 'orphan-cleanup-healthy-list' });
		for (const category of healthy) renderDashboardCategory(view, healthyList, category, false);
	}

	const pending = view.scanning ? [] : CLEANUP_CATEGORIES.filter((category) => categoryCount(view.candidates, category.tab) === 0 && (!view.scannedTabs.has(category.tab) || view.dirtyTabs.has(category.tab)));
	if (pending.length) {
		const pendingSection = home.createDiv({ cls: 'orphan-cleanup-dashboard-section orphan-cleanup-dashboard-pending' });
		const pendingHeading = pendingSection.createDiv({ cls: 'orphan-cleanup-dashboard-section-heading' });
		pendingHeading.createEl('h3', { text: '待检查 / 复核' });
		pendingHeading.createSpan({ text: '未扫描或结果已过期' });
		const pendingList = pendingSection.createDiv({ cls: 'orphan-cleanup-healthy-list' });
		for (const category of pending) renderDashboardCategory(view, pendingList, category, false);
	}
	updateScanProgress(view);
}

function renderScanError(view: CleanupViewContext, container: HTMLElement) {
	const error = view.lastScanError;
	if (!error) return;
	const banner = container.createDiv({ cls: 'orphan-cleanup-scan-error' });
	banner.setAttribute('role', 'alert');
	const failedLabels = CLEANUP_CATEGORIES
		.filter((category) => error.failedTabs.includes(category.tab))
		.map((category) => category.label);
	banner.createEl('strong', { text: failedLabels.length ? `上次扫描未完成：${failedLabels.join('、')}` : '上次扫描未完成' });
	banner.createSpan({ text: `${error.reason} 请点击「${view.hasScanned ? '重新扫描全部' : '开始扫描'}」重试。` });
}

export function renderDashboardCategory(view: CleanupViewContext, container: HTMLElement, category: (typeof CLEANUP_CATEGORIES)[number], priority: boolean) {
	const count = categoryCount(view.candidates, category.tab);
	const scanned = view.scannedTabs.has(category.tab);
	const scanning = view.scanningTabs.has(category.tab);
	const dirty = view.dirtyTabs.has(category.tab);

	const card = container.createDiv({ cls: priority ? 'orphan-cleanup-dashboard-item is-priority' : 'orphan-cleanup-dashboard-item' });
	card.dataset.tab = category.tab;
	if (scanning) card.addClass('is-scanning');
	else if (dirty) card.addClass('is-dirty');
	else if (count > 0) card.addClass('has-issues');
	else if (scanned) card.addClass('is-healthy');

	const icon = card.createDiv({ cls: 'orphan-cleanup-dashboard-icon' });
	setIcon(icon, category.icon);
	const body = card.createDiv({ cls: 'orphan-cleanup-dashboard-item-body' });
	const title = body.createDiv({ cls: 'orphan-cleanup-dashboard-item-title' });
	title.createEl('strong', { text: category.label });
	if (priority) title.createSpan({ text: view.scanning && !scanned ? '—' : String(count), cls: count > 0 ? 'orphan-cleanup-dashboard-item-count' : 'orphan-cleanup-dashboard-item-count is-zero' });
	body.createDiv({ text: category.description, cls: 'orphan-cleanup-dashboard-item-desc' });
	body.createDiv({ text: categoryStatus(count, scanned, scanning, dirty), cls: 'orphan-cleanup-dashboard-item-status' });

	const actions = card.createDiv({ cls: 'orphan-cleanup-dashboard-item-actions' });
	const scanText = scanning ? '扫描中…' : scanned ? '重新扫描' : '扫描';
	const scanButton = actions.createEl('button', { text: scanText });
	// 首屏 8 个分类的按钮文字相同，无障碍名称需带上分类，否则屏幕阅读器无法区分。
	scanButton.setAttribute('aria-label', `${category.label}：${scanText}`);
	scanButton.disabled = view.scanning || scanning;
	scanButton.addEventListener('click', (event) => { event.stopPropagation(); void view.scanCategory(category.tab); });
	const viewButton = actions.createEl('button', { text: '查看' });
	viewButton.setAttribute('aria-label', `${category.label}：查看`);
	viewButton.disabled = view.scanning || !scanned || scanning;
	viewButton.addEventListener('click', (event) => { event.stopPropagation(); void view.activateTab(category.tab); });

	card.addEventListener('click', () => { if (!view.scanning && !scanning && scanned) void view.activateTab(category.tab); });
}

export function renderTabs(view: CleanupViewContext) {
	const tabs = view.contentEl.createDiv({ cls: 'orphan-cleanup-tabs' });
	let activeTabButton: HTMLButtonElement | undefined;
	for (const [tab, label, count] of tabEntries(view.candidates, view.scanning)) {
		const button = tabs.createEl('button', {
			text: `${label}（${count}）`,
			cls: tab === view.activeTab ? 'orphan-cleanup-tab is-active' : 'orphan-cleanup-tab',
		});
		button.dataset.tab = tab;
		button.disabled = view.scanning;
		if (tab === view.activeTab) {
			activeTabButton = button;
			button.setAttribute('aria-current', 'true');
		}
		button.addEventListener('click', () => void view.activateTab(tab));
	}
	// 标签条横向滚动时，当前分类必须自动进入可视区，否则用户看不到自己处于哪个标签。
	activeTabButton?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
	const help = tabs.createEl('button', { text: '!', cls: 'orphan-cleanup-help-button' });
	help.type = 'button';
	help.title = '查看使用说明';
	help.setAttribute('aria-label', '查看使用说明');
	help.setAttribute('aria-expanded', String(view.showHelp));
	help.setAttribute('aria-controls', helpPanelId(view));
	help.addEventListener('click', () => {
		view.showHelp = !view.showHelp;
		view.renderContents();
	});
}

export function renderHelp(view: CleanupViewContext) {
	const help = view.contentEl.createDiv({ cls: 'orphan-cleanup-help' });
	help.setAttribute('id', helpPanelId(view));
	help.createEl('strong', { text: '使用说明' });
	help.createSpan({ text: '未勾选的项目不会被处理；确认后会移入 Obsidian 回收站。' });
}

export function renderProcessedSummary(view: CleanupViewContext) {
	const summary = view.contentEl.createDiv({ cls: 'orphan-cleanup-result-summary' });
	summary.setAttribute('role', 'status');
	const failed = view.processed?.failed ?? [];
	summary.createEl('strong', { text: '最近一次处理：' });
	summary.createSpan({ text: `成功 ${view.processed?.success ?? 0}，跳过 ${view.processed?.skipped ?? 0}，失败 ${failed.length}` });
	if (failed.length) summary.createDiv({ text: failed.map((item) => `${item.path}（${item.reason}）`).join('、') });
}
