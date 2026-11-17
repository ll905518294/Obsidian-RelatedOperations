import { setIcon } from 'obsidian';
import { CLEANUP_CATEGORIES, type CleanupTab, type CleanupViewContext, type ScanCategoryTab } from './cleanup-types';
import { categoryCount, categoryStatus, categoryTotal, formatScanDuration, scanPercent, tabEntries } from './cleanup-selectors';
import { announceStatus, ensureLiveRegion, nextListElementId, setTextIfChanged } from './cleanup-a11y';
export { categoryStatus, tabEntries };

const CONVERSION_TAB: CleanupTab = 'image-convert';

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
	setTextIfChanged(view.contentEl.querySelector<HTMLElement>('.orphan-cleanup-dashboard-progress-meta'), view.scanning ? `${label} · ${percent}% · 用时 ${formatScanDuration(view.scanElapsedMs)}` : view.lastScanAborted ? '扫描已中止' : '扫描完成');
	setTextIfChanged(view.contentEl.querySelector<HTMLElement>('.orphan-cleanup-dashboard-current-file'), currentFile ? `当前文件：${currentFile}` : (view.scanning ? '正在准备扫描…' : view.lastScanAborted ? '已保留已完成的分类结果' : '扫描结果已更新'));
	view.contentEl.querySelector<HTMLElement>('.orphan-cleanup-dashboard-progress-bar-wrap')?.setAttribute('aria-valuenow', String(percent));
	for (const item of Array.from(view.contentEl.querySelectorAll<HTMLElement>('.orphan-cleanup-dashboard-item[data-tab]'))) {
		const tab = item.dataset.tab as ScanCategoryTab;
		if (tab === 'image-convert') {
			// 图片压缩卡片不走 9 类扫描编排：全量扫描不会刷新它，
			// 状态只由估算进度与「是否已枚举候选」决定。
			item.toggleClass('is-scanning', view.conversion.estimating);
			setTextIfChanged(item.querySelector<HTMLElement>('.orphan-cleanup-dashboard-item-status'), conversionStatus(view, view.candidates.convertibleImages.length));
			continue;
		}
		const completed = view.scannedTabs.has(tab);
		const current = view.scanning && !completed && categoryScanStage(tab) === stage;
		item.toggleClass('is-scanning', current);
		setTextIfChanged(item.querySelector<HTMLElement>('.orphan-cleanup-dashboard-item-status'), view.scanning
			? completed ? `已完成 · ${categoryCount(view.candidates, tab)} 项` : current ? '正在扫描…' : '等待扫描'
			: categoryStatus(categoryCount(view.candidates, tab), completed, false, view.dirtyTabs.has(tab)));
	}
	const ring = view.contentEl.querySelector<HTMLElement>('.orphan-cleanup-dashboard-progress-ring');
	if (ring) {
		const scannedCategories = CLEANUP_CATEGORIES.filter((category) => view.scannedTabs.has(category.tab)).length;
		ring.style.setProperty('--scan-progress', `${view.scanning ? percent : scannedCategories / CLEANUP_CATEGORIES.length * 100}%`);
	}
	// 进度百分比每个 tick 都变，逐条播报会刷屏；只播报阶段级里程碑。
	if (view.scanning) announceStatus(view.contentEl, `正在扫描：${label}`);
	else if (view.lastScanAborted) announceStatus(view.contentEl, '扫描已中止，已保留已完成的分类结果');
	else if (view.lastScanError) {
		// 部分分类失败时不能播报「扫描完成」，否则屏幕阅读器会误导。
		announceStatus(view.contentEl, '扫描未完成，部分分类结果已保留');
	} else if (view.hasScanned) announceStatus(view.contentEl, `扫描完成，共 ${categoryTotal(view.candidates) + view.candidates.convertibleImages.length} 项待处理`);
}

function categoryScanStage(tab: ScanCategoryTab): number {
	return tab === 'images' || tab === 'attachments' ? 2 : tab === 'empty-files' || tab === 'folders' ? 3 : tab === 'duplicates' ? 5 : 4;
}

export function renderOverview(view: CleanupViewContext) {
	const home = view.contentEl.createDiv({ cls: 'orphan-cleanup-home orphan-cleanup-dashboard' });
	if (view.scanning) home.addClass('is-scanning');
	// 扫描进行中给容器加 aria-busy，屏幕阅读器与辅助技术据此跳过对未稳定内容的逐条读取。
	if (view.scanning) home.setAttribute('aria-busy', 'true');
	// 图片压缩是独立功能 tab：它不属于 9 类扫描分类（不驱动扫描编排），
	// 但「有候选」时是可处理项，需要并入首页待处理总数，让用户在首页就能看到它。
	const convertCount = view.candidates.convertibleImages.length;
	const total = categoryTotal(view.candidates) + convertCount;
	const scanned = CLEANUP_CATEGORIES.filter((category) => view.scannedTabs.has(category.tab)).length;
	const categoryDirty = CLEANUP_CATEGORIES.some((category) => view.dirtyTabs.has(category.tab));
	const stale = CLEANUP_CATEGORIES.filter((category) => view.scannedTabs.has(category.tab) && view.dirtyTabs.has(category.tab)).length;
	const header = home.createDiv({ cls: 'orphan-cleanup-home-header' });
	const heading = header.createDiv({ cls: 'orphan-cleanup-home-heading' });
	heading.createDiv({ text: 'Vault 健康概览', cls: 'orphan-cleanup-home-eyebrow' });
	heading.createEl('h2', { text: view.scanning ? '正在检查资料库' : total ? '需要你的注意' : scanned < CLEANUP_CATEGORIES.length || categoryDirty ? '等待检查资料库' : '资料库状态良好' });
	heading.createEl('p', { text: overviewSubtitle(view), cls: 'orphan-cleanup-home-subtitle' });
	const actions = header.createDiv({ cls: 'orphan-cleanup-home-actions' });
	const scanAll = actions.createEl('button', { text: view.scanning ? '扫描中…' : view.hasScanned ? '重新扫描全部' : '开始扫描', cls: 'mod-cta orphan-cleanup-scan-all' });
	scanAll.disabled = view.scanning || view.scanningTabs.size > 0;
	scanAll.addEventListener('click', () => void view.scan());
	if (view.scanning) {
		const abort = actions.createEl('button', { text: '中止扫描', cls: 'orphan-cleanup-abort-scan' });
		abort.setAttribute('aria-label', '中止当前扫描并保留已完成的分类结果');
		abort.addEventListener('click', () => view.abortScan());
	}

	const hero = header.createDiv({ cls: 'orphan-cleanup-dashboard-hero' });
	const heroCopy = hero.createDiv({ cls: 'orphan-cleanup-dashboard-hero-copy' });
	heroCopy.createDiv({ text: view.scanning ? '扫描中的现有结果' : '当前待处理', cls: 'orphan-cleanup-dashboard-label' });
	heroCopy.createDiv({ text: String(total), cls: 'orphan-cleanup-dashboard-total' });
	heroCopy.createDiv({
		text: `${scanned} / ${CLEANUP_CATEGORIES.length} 个分类已扫描${stale ? ` · ${stale} 类待复核` : ''}${!view.scanning && convertCount > 0 ? ` · ${convertCount} 张图片待压缩` : ''}`,
		cls: 'orphan-cleanup-dashboard-meta',
	});
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
	renderScanAborted(view, home);

	const priority = CLEANUP_CATEGORIES
		.filter((category) => view.scanning || categoryCount(view.candidates, category.tab) > 0)
		.sort((a, b) => view.scanning
			? categoryScanStage(a.tab) - categoryScanStage(b.tab)
			: categoryCount(view.candidates, b.tab) - categoryCount(view.candidates, a.tab));
	// 图片压缩卡片与扫描分类同区展示：有候选时归入优先处理，无候选且已估算归入已检查，
	// 未估算/结果过期归入待检查。
	const conversionScanned = view.scannedTabs.has(CONVERSION_TAB);
	const conversionDirty = view.dirtyTabs.has(CONVERSION_TAB);
	const conversionInPriority = view.scanning || convertCount > 0;
	const conversionInHealthy = !view.scanning && convertCount === 0 && conversionScanned && !conversionDirty;
	const conversionInPending = !view.scanning && convertCount === 0 && !conversionInHealthy;
	const prioritySection = home.createDiv({ cls: 'orphan-cleanup-dashboard-section' });
	const priorityHeading = prioritySection.createDiv({ cls: 'orphan-cleanup-dashboard-section-heading' });
	priorityHeading.createEl('h3', { text: view.scanning ? '扫描进度' : '优先处理' });
	priorityHeading.createSpan({ text: view.scanning ? '模块完成后会直接更新状态' : priority.length ? '按问题数量排序' : '没有待处理项目' });
	const priorityGrid = prioritySection.createDiv({ cls: 'orphan-cleanup-priority-grid' });
	if (priority.length) for (const category of priority) renderDashboardCategory(view, priorityGrid, category, true);
	if (conversionInPriority) renderConversionCard(view, priorityGrid, 'priority');
	const priorityCards = priority.length + (conversionInPriority ? 1 : 0);
	if (priorityCards === 0) {
		// 尚未扫描任何分类时，不能播报「很干净」——此时没有已检查内容，
		// 会让用户误以为资料库已经确认无问题而错过扫描。区分未扫描与已扫描且干净两种空态。
		const empty = priorityGrid.createDiv({ cls: scanned === 0 ? 'orphan-cleanup-dashboard-empty is-idle' : 'orphan-cleanup-dashboard-empty' });
		empty.setText(scanned === 0 ? '还没有扫描结果，点击「开始扫描」检查资料库。' : '所有已检查分类都很干净。');
	}

	const healthy = view.scanning ? [] : CLEANUP_CATEGORIES.filter((category) => view.scannedTabs.has(category.tab) && categoryCount(view.candidates, category.tab) === 0 && !view.dirtyTabs.has(category.tab));
	if (healthy.length) {
		const healthySection = home.createDiv({ cls: 'orphan-cleanup-dashboard-section orphan-cleanup-dashboard-healthy' });
		const healthyHeading = healthySection.createDiv({ cls: 'orphan-cleanup-dashboard-section-heading' });
		healthyHeading.createEl('h3', { text: '已检查' });
		healthyHeading.createSpan({ text: `${healthy.length} 个分类没有问题` });
		const healthyList = healthySection.createDiv({ cls: 'orphan-cleanup-healthy-list' });
		for (const category of healthy) renderDashboardCategory(view, healthyList, category, false);
		if (conversionInHealthy) renderConversionCard(view, healthyList, 'healthy');
	}

	const pending = view.scanning ? [] : CLEANUP_CATEGORIES.filter((category) => categoryCount(view.candidates, category.tab) === 0 && (!view.scannedTabs.has(category.tab) || view.dirtyTabs.has(category.tab)));
	if (pending.length || conversionInPending) {
		const pendingSection = home.createDiv({ cls: 'orphan-cleanup-dashboard-section orphan-cleanup-dashboard-pending' });
		const pendingHeading = pendingSection.createDiv({ cls: 'orphan-cleanup-dashboard-section-heading' });
		pendingHeading.createEl('h3', { text: '待检查 / 复核' });
		pendingHeading.createSpan({ text: '未扫描或结果已过期' });
		const pendingList = pendingSection.createDiv({ cls: 'orphan-cleanup-healthy-list' });
		for (const category of pending) renderDashboardCategory(view, pendingList, category, false);
		if (conversionInPending) renderConversionCard(view, pendingList, 'pending');
	}
	// 关联笔记整理是独立视图，不参与 9 类扫描；作为体检首页的固定入口，
	// 用户无需再记一个侧栏图标或独立命令。
	const relatedSection = home.createDiv({ cls: 'orphan-cleanup-dashboard-section' });
	const relatedHeading = relatedSection.createDiv({ cls: 'orphan-cleanup-dashboard-section-heading' });
	relatedHeading.createEl('h3', { text: '相关功能' });
	relatedHeading.createSpan({ text: '不参与资料库扫描' });
	renderRelatedNotesCard(view, relatedSection.createDiv({ cls: 'orphan-cleanup-priority-grid' }));
	updateScanProgress(view);
}

/** 图片压缩卡片：功能入口在首页可见，行为与其它分类卡片一致（进入 image-convert 页签）。 */
function renderConversionCard(view: CleanupViewContext, container: HTMLElement, group: 'priority' | 'pending' | 'healthy') {
	const count = view.candidates.convertibleImages.length;
	const scanned = view.scannedTabs.has(CONVERSION_TAB);
	const dirty = view.dirtyTabs.has(CONVERSION_TAB);

	const card = container.createDiv({ cls: group === 'priority' ? 'orphan-cleanup-dashboard-item is-priority' : 'orphan-cleanup-dashboard-item' });
	card.dataset.tab = CONVERSION_TAB;
	if (view.conversion.estimating) card.addClass('is-scanning');
	else if (dirty) card.addClass('is-dirty');
	else if (count > 0) card.addClass('has-issues');
	else if (scanned) card.addClass('is-healthy');

	const icon = card.createDiv({ cls: 'orphan-cleanup-dashboard-icon' });
	setIcon(icon, 'image-plus');
	const body = card.createDiv({ cls: 'orphan-cleanup-dashboard-item-body' });
	const title = body.createDiv({ cls: 'orphan-cleanup-dashboard-item-title' });
	title.createEl('strong', { text: '图片压缩' });
	if (group === 'priority') title.createSpan({ text: count > 0 ? String(count) : '—', cls: count > 0 ? 'orphan-cleanup-dashboard-item-count' : 'orphan-cleanup-dashboard-item-count is-zero' });
	body.createDiv({ text: '把图片转成 JPG / WebP 并改写全部引用', cls: 'orphan-cleanup-dashboard-item-desc' });
	body.createDiv({ text: conversionStatus(view, count), cls: 'orphan-cleanup-dashboard-item-status' });

	const actions = card.createDiv({ cls: 'orphan-cleanup-dashboard-item-actions' });
	const viewButton = actions.createEl('button', { text: '查看' });
	viewButton.setAttribute('aria-label', '图片压缩：查看');
	viewButton.disabled = view.scanning;
	viewButton.addEventListener('click', (event) => { event.stopPropagation(); void view.activateTab(CONVERSION_TAB); });
	card.addEventListener('click', () => { if (!view.scanning) void view.activateTab(CONVERSION_TAB); });
}

function conversionStatus(view: CleanupViewContext, count: number): string {
	if (view.conversion.estimating) return '正在估算…';
	if (view.scanning) return '等待估算（全量扫描不含此项）';
	if (!view.scannedTabs.has(CONVERSION_TAB)) return '尚未估算';
	if (view.dirtyTabs.has(CONVERSION_TAB)) return '结果待复核，请重新估算';
	return count > 0 ? `${count} 张图片可压缩` : '没有可压缩的图片';
}

/** 关联笔记整理入口：打开独立视图，使用当前活动/所选笔记作为源。 */
function renderRelatedNotesCard(view: CleanupViewContext, container: HTMLElement) {
	const card = container.createDiv({ cls: 'orphan-cleanup-dashboard-item' });
	card.dataset.tool = 'related-notes';

	const icon = card.createDiv({ cls: 'orphan-cleanup-dashboard-icon' });
	setIcon(icon, 'move');
	const body = card.createDiv({ cls: 'orphan-cleanup-dashboard-item-body' });
	const title = body.createDiv({ cls: 'orphan-cleanup-dashboard-item-title' });
	title.createEl('strong', { text: '关联笔记整理' });
	body.createDiv({ text: '以当前笔记或所选笔记为源，整理关联笔记', cls: 'orphan-cleanup-dashboard-item-desc' });
	body.createDiv({ text: '独立页面 · 不参与资料库扫描', cls: 'orphan-cleanup-dashboard-item-status' });

	const actions = card.createDiv({ cls: 'orphan-cleanup-dashboard-item-actions' });
	const open = () => { if (!view.scanning) view.openRelatedNotes?.(); };
	const openButton = actions.createEl('button', { text: '打开' });
	openButton.setAttribute('aria-label', '关联笔记整理：打开');
	openButton.disabled = view.scanning;
	openButton.addEventListener('click', (event) => { event.stopPropagation(); open(); });
	card.addEventListener('click', open);
}

function overviewSubtitle(view: CleanupViewContext): string {
	if (view.scanning) return '扫描会在当前页面持续进行，结果将直接显示在对应模块。';
	const scanTime = formatScanTime(view.lastScannedAt);
	if (view.showingCachedResult) {
		return scanTime
			? `显示上次扫描结果（${scanTime}）。点击「重新扫描全部」更新。`
			: '显示上次扫描结果。点击「重新扫描全部」更新。';
	}
	return scanTime
		? `上次扫描：${scanTime}。扫描仅在本地进行，不会修改任何文件。`
		: '扫描仅在本地进行，不会修改任何文件。';
}

function formatScanTime(value?: string): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString('zh-CN');
}

function renderScanAborted(view: CleanupViewContext, container: HTMLElement) {
	if (!view.lastScanAborted || view.scanning) return;
	const pending = CLEANUP_CATEGORIES.filter((category) => !view.scannedTabs.has(category.tab));
	const completed = CLEANUP_CATEGORIES.length - pending.length;
	const banner = container.createDiv({ cls: 'orphan-cleanup-scan-error is-aborted' });
	banner.setAttribute('role', 'status');
	banner.createEl('strong', { text: '扫描已中止' });
	const retry = view.hasScanned ? '重新扫描全部' : '开始扫描';
	banner.createSpan({
		text: pending.length
			? `已完成 ${completed} 个分类；其余 ${pending.length} 个分类待重新扫描。点击「${retry}」继续。`
			: '全部结果已保留。',
	});
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

function renderDashboardCategory(view: CleanupViewContext, container: HTMLElement, category: (typeof CLEANUP_CATEGORIES)[number], priority: boolean) {
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
	// live 区域先于页面内容建立，状态变化时才能被屏幕阅读器捕捉到。
	ensureLiveRegion(view.contentEl);
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
	const failed = view.processed?.failed ?? [];
	const success = view.processed?.success ?? 0;
	const skipped = view.processed?.skipped ?? 0;
	summary.createEl('strong', { text: '最近一次处理：' });
	summary.createSpan({ text: `成功 ${success}，跳过 ${skipped}，失败 ${failed.length}` });
	if (failed.length) summary.createDiv({ text: failed.map((item) => `${item.path}（${item.reason}）`).join('、') });
	// 结果摘要每次重绘都会重建，直接标 role=status 会把同一份结果反复朗读；
	// 改由统一的 live 区域播报，重复内容会被去重。
	announceStatus(view.contentEl, `最近一次处理：成功 ${success}，跳过 ${skipped}，失败 ${failed.length}`);
}
