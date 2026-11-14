import { setIcon } from 'obsidian';
import type { OrphanCleanupPanel } from './cleanup-panel';
import { CLEANUP_CATEGORIES, type CleanupTab, type ScanCategoryTab } from './cleanup-types';
import { formatScanDuration } from './cleanup-actions';
export function updateScanProgress(host: OrphanCleanupPanel) {
		const { processed, total, stage, currentFile } = host.scanProgress;
		const stagePercent = total > 0 ? processed / total : 0;
		const percent = host.scanning ? Math.min(99, Math.round(((stage + stagePercent) / Math.max(host.scanStages.length, 1)) * 100)) : 100;
		const label = host.scanStages[stage]?.label ?? '扫描完成';
		host.contentEl.querySelector<HTMLElement>('.orphan-cleanup-dashboard-progress-bar')?.style.setProperty('width', `${percent}%`);
		host.contentEl.querySelector<HTMLElement>('.orphan-cleanup-dashboard-progress-meta')?.setText(host.scanning ? `${label} · ${percent}% · 用时 ${formatScanDuration(host.scanElapsedMs)}` : '扫描完成');
		host.contentEl.querySelector<HTMLElement>('.orphan-cleanup-dashboard-current-file')?.setText(currentFile ? `当前文件：${currentFile}` : (host.scanning ? '正在准备扫描…' : '扫描结果已更新'));
		host.contentEl.querySelector<HTMLElement>('.orphan-cleanup-dashboard-progress-bar-wrap')?.setAttribute('aria-valuenow', String(percent));
		for (const item of Array.from(host.contentEl.querySelectorAll<HTMLElement>('.orphan-cleanup-dashboard-item[data-tab]'))) {
			const tab = item.dataset.tab as ScanCategoryTab;
			const completed = host.scannedTabs.has(tab);
			const current = host.scanning && !completed && categoryScanStage(tab) === stage;
			item.toggleClass('is-scanning', current);
			item.querySelector<HTMLElement>('.orphan-cleanup-dashboard-item-status')?.setText(host.scanning
				? completed ? `已完成 · ${categoryCount(host, tab)} 项` : current ? '正在扫描…' : '等待扫描'
				: categoryStatus(categoryCount(host, tab), completed, false, host.dirtyTabs.has(tab)));
		}
		const ring = host.contentEl.querySelector<HTMLElement>('.orphan-cleanup-dashboard-progress-ring');
		if (ring) ring.style.setProperty('--scan-progress', `${host.scanning ? percent : host.scannedTabs.size / CLEANUP_CATEGORIES.length * 100}%`);
	}

export function categoryScanStage(tab: ScanCategoryTab): number {
		return tab === 'images' || tab === 'attachments' ? 2 : tab === 'empty-files' || tab === 'folders' ? 3 : tab === 'duplicates' ? 5 : 4;
	}

export function renderOverview(host: OrphanCleanupPanel) {
		const home = host.contentEl.createDiv({ cls: 'orphan-cleanup-home orphan-cleanup-dashboard' });
		if (host.scanning) home.addClass('is-scanning');
		const total = categoryTotal(host);
		const scanned = host.scannedTabs.size;
		const stale = CLEANUP_CATEGORIES.filter((category) => host.scannedTabs.has(category.tab) && host.dirtyTabs.has(category.tab)).length;
		const header = home.createDiv({ cls: 'orphan-cleanup-home-header' });
		const heading = header.createDiv({ cls: 'orphan-cleanup-home-heading' });
		heading.createDiv({ text: 'Vault 健康概览', cls: 'orphan-cleanup-home-eyebrow' });
		heading.createEl('h2', { text: host.scanning ? '正在检查资料库' : total ? '需要你的注意' : scanned < CLEANUP_CATEGORIES.length || host.dirtyTabs.size ? '等待检查资料库' : '资料库状态良好' });
		heading.createEl('p', { text: host.scanning ? '扫描会在当前页面持续进行，结果将直接显示在对应模块。' : '扫描仅在本地进行，不会修改任何文件。', cls: 'orphan-cleanup-home-subtitle' });
		const scanAll = header.createEl('button', { text: host.scanning ? '扫描中…' : host.hasScanned ? '重新扫描全部' : '开始扫描', cls: 'mod-cta orphan-cleanup-scan-all' });
		scanAll.disabled = host.scanning || host.scanningTabs.size > 0;
		scanAll.addEventListener('click', () => void host.scan());

		const hero = header.createDiv({ cls: 'orphan-cleanup-dashboard-hero' });
		const heroCopy = hero.createDiv({ cls: 'orphan-cleanup-dashboard-hero-copy' });
		heroCopy.createDiv({ text: host.scanning ? '扫描中的现有结果' : '当前待处理', cls: 'orphan-cleanup-dashboard-label' });
		heroCopy.createDiv({ text: String(total), cls: 'orphan-cleanup-dashboard-total' });
		heroCopy.createDiv({ text: `${scanned} / ${CLEANUP_CATEGORIES.length} 个分类已扫描${stale ? ` · ${stale} 类待复核` : ''}`, cls: 'orphan-cleanup-dashboard-meta' });
		if (host.scanning) {
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

		const priority = CLEANUP_CATEGORIES
			.filter((category) => host.scanning || categoryCount(host, category.tab) > 0)
			.sort((a, b) => host.scanning
				? categoryScanStage(a.tab) - categoryScanStage(b.tab)
				: categoryCount(host, b.tab) - categoryCount(host, a.tab));
		const prioritySection = home.createDiv({ cls: 'orphan-cleanup-dashboard-section' });
		const priorityHeading = prioritySection.createDiv({ cls: 'orphan-cleanup-dashboard-section-heading' });
		priorityHeading.createEl('h3', { text: host.scanning ? '扫描进度' : '优先处理' });
		priorityHeading.createSpan({ text: host.scanning ? '模块完成后会直接更新状态' : priority.length ? '按问题数量排序' : '没有待处理项目' });
		const priorityGrid = prioritySection.createDiv({ cls: 'orphan-cleanup-priority-grid' });
		if (priority.length) for (const category of priority) renderDashboardCategory(host, priorityGrid, category, true);
		else priorityGrid.createDiv({ text: '所有已检查分类都很干净。', cls: 'orphan-cleanup-dashboard-empty' });

		const healthy = host.scanning ? [] : CLEANUP_CATEGORIES.filter((category) => host.scannedTabs.has(category.tab) && categoryCount(host, category.tab) === 0 && !host.dirtyTabs.has(category.tab));
		if (healthy.length) {
			const healthySection = home.createDiv({ cls: 'orphan-cleanup-dashboard-section orphan-cleanup-dashboard-healthy' });
			const healthyHeading = healthySection.createDiv({ cls: 'orphan-cleanup-dashboard-section-heading' });
			healthyHeading.createEl('h3', { text: '已检查' });
			healthyHeading.createSpan({ text: `${healthy.length} 个分类没有问题` });
			const healthyList = healthySection.createDiv({ cls: 'orphan-cleanup-healthy-list' });
			for (const category of healthy) renderDashboardCategory(host, healthyList, category, false);
		}

		const pending = host.scanning ? [] : CLEANUP_CATEGORIES.filter((category) => categoryCount(host, category.tab) === 0 && (!host.scannedTabs.has(category.tab) || host.dirtyTabs.has(category.tab)));
		if (pending.length) {
			const pendingSection = home.createDiv({ cls: 'orphan-cleanup-dashboard-section orphan-cleanup-dashboard-pending' });
			const pendingHeading = pendingSection.createDiv({ cls: 'orphan-cleanup-dashboard-section-heading' });
			pendingHeading.createEl('h3', { text: '待检查 / 复核' });
			pendingHeading.createSpan({ text: '未扫描或结果已过期' });
			const pendingList = pendingSection.createDiv({ cls: 'orphan-cleanup-healthy-list' });
			for (const category of pending) renderDashboardCategory(host, pendingList, category, false);
		}
		updateScanProgress(host);
	}

export function categoryTotal(host: OrphanCleanupPanel) {
		return CLEANUP_CATEGORIES.reduce((total, category) => total + categoryCount(host, category.tab), 0);
	}

export function categoryCount(host: OrphanCleanupPanel, tab: ScanCategoryTab): number {
		switch (tab) {
			case 'images': return host.candidates.images.length;
			case 'attachments': return host.candidates.attachments.length;
			case 'broken-links': return host.candidates.brokenLinks.length;
			case 'native-links': return host.candidates.nativeLinks.length;
			case 'broken-note-links': return host.candidates.brokenNoteLinks.length;
			case 'empty-files': return host.candidates.emptyFiles.length;
			case 'folders': return host.candidates.folders.length;
			case 'duplicates': return host.candidates.duplicates.length;
		}
	}

export function renderDashboardCategory(host: OrphanCleanupPanel, container: HTMLElement, category: (typeof CLEANUP_CATEGORIES)[number], priority: boolean) {
		const count = categoryCount(host, category.tab);
		const scanned = host.scannedTabs.has(category.tab);
		const scanning = host.scanningTabs.has(category.tab);
		const dirty = host.dirtyTabs.has(category.tab);

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
		if (priority) title.createSpan({ text: host.scanning && !scanned ? '—' : String(count), cls: count > 0 ? 'orphan-cleanup-dashboard-item-count' : 'orphan-cleanup-dashboard-item-count is-zero' });
		body.createDiv({ text: category.description, cls: 'orphan-cleanup-dashboard-item-desc' });
		body.createDiv({ text: categoryStatus(count, scanned, scanning, dirty), cls: 'orphan-cleanup-dashboard-item-status' });

		const actions = card.createDiv({ cls: 'orphan-cleanup-dashboard-item-actions' });
		const scanButton = actions.createEl('button', { text: scanning ? '扫描中…' : scanned ? '重新扫描' : '扫描' });
		scanButton.disabled = host.scanning || scanning;
		scanButton.addEventListener('click', (event) => { event.stopPropagation(); void host.scanCategory(category.tab); });
		const viewButton = actions.createEl('button', { text: '查看' });
		viewButton.disabled = host.scanning || !scanned || scanning;
		viewButton.addEventListener('click', (event) => { event.stopPropagation(); void host.activateTab(category.tab); });

		card.addEventListener('click', () => { if (!host.scanning && !scanning && scanned) void host.activateTab(category.tab); });
	}

export function categoryStatus(count: number, scanned: boolean, scanning: boolean, dirty: boolean): string {
		if (scanning) return '正在扫描…';
		if (!scanned) return '尚未扫描';
		if (dirty) return '结果待复核，请重新扫描';
		return count > 0 ? `发现 ${count} 项` : '未发现问题';
	}

export function tabEntries(host: OrphanCleanupPanel): Array<[CleanupTab, string, number]> {
		const categories = CLEANUP_CATEGORIES.map(({ tab, label }) => ({ tab, label, count: categoryCount(host, tab) }));
		if (!host.scanning) categories.sort((a, b) => Number(b.count > 0) - Number(a.count > 0));
		return [['overview', '体检首页', categoryTotal(host)], ...categories.map(({ tab, label, count }): [CleanupTab, string, number] => [tab, label, count])];
	}

export function renderTabs(host: OrphanCleanupPanel) {
		const tabs = host.contentEl.createDiv({ cls: 'orphan-cleanup-tabs' });
		for (const [tab, label, count] of tabEntries(host)) {
			const button = tabs.createEl('button', {
				text: `${label}（${count}）`,
				cls: tab === host.activeTab ? 'orphan-cleanup-tab is-active' : 'orphan-cleanup-tab',
			});
			button.dataset.tab = tab;
			button.disabled = host.scanning;
			button.addEventListener('click', () => void host.activateTab(tab));
		}
		const help = tabs.createEl('button', { text: '!', cls: 'orphan-cleanup-help-button' });
		help.type = 'button';
		help.title = '查看使用说明';
		help.setAttribute('aria-label', '查看使用说明');
		help.setAttribute('aria-expanded', String(host.showHelp));
		help.addEventListener('click', () => {
			host.showHelp = !host.showHelp;
			host.renderContents();
		});
	}


export function renderHelp(host: OrphanCleanupPanel) {
		const help = host.contentEl.createDiv({ cls: 'orphan-cleanup-help' });
		help.createEl('strong', { text: '使用说明' });
		help.createSpan({ text: '未勾选的项目不会被处理；确认后会移入 Obsidian 回收站。' });
	}

export function renderProcessedSummary(host: OrphanCleanupPanel) {
		const summary = host.contentEl.createDiv({ cls: 'orphan-cleanup-result-summary' });
		summary.setAttribute('role', 'status');
		const failed = host.processed?.failed ?? [];
		summary.createEl('strong', { text: '最近一次处理：' });
		summary.createSpan({ text: `成功 ${host.processed?.success ?? 0}，跳过 ${host.processed?.skipped ?? 0}，失败 ${failed.length}` });
		if (failed.length) summary.createDiv({ text: failed.map((item) => `${item.path}（${item.reason}）`).join('、') });
	}
