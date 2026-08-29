import { App, FileSystemAdapter, MarkdownView, Modal, Notice, Platform, TAbstractFile, TFile, TFolder } from 'obsidian';
import { hasHiddenPathSegment, isIgnoredPath, needsRawTextSearch, parseExtensions, parseIgnoredFolders, pathLikeTokens, pathTokenCandidates } from './core-utils';
import { buildCleanupReport } from './cleanup-report';
import { brokenLinkKey, findBrokenImageLinks, findBrokenLinkOffset, removeSelectedBrokenLinks, type BrokenImageLink } from './broken-image-links';
import { convertNativeImageLink, findNativeImageLinks, nativeImageLinkKey, nativeImageLinkOffset, replaceNativeImageLinks, type NativeImageLink } from './native-image-links';

type ImageGrouping = 'none' | 'path' | 'extension';
const CLEANUP_PAGE_SIZE = 100;

interface CleanupCandidates {
	images: TFile[];
	folders: TFolder[];
	brokenLinks: BrokenImageLink[];
	nativeLinks: NativeImageLink[];
}

interface CleanupResult {
	deleted: string[];
	failed: Array<{ path: string; reason: string }>;
}

interface OrphanImageExtensions {
	orphanImageExtensions: string;
	orphanIgnoredFolders: string;
}

export interface OrphanCleanupHost {
	close(): void;
}

export class OrphanCleanupPanel {
	private candidates: CleanupCandidates = { images: [], folders: [], brokenLinks: [], nativeLinks: [] };
	private selections = new Set<string>();
	private linkSelections = new Set<string>();
	private nativeSelections = new Set<string>();
	private activeTab: string = 'images';
	private imageGrouping: ImageGrouping = 'none';
	private scanning = false;
	private showHelp = false;
	private readonly pages = new Map<string, number>();
	private processed?: { success: number; skipped: number; failed: Array<{ path: string; reason: string }> };

	constructor(
		private readonly app: App,
		private readonly contentEl: HTMLElement,
		private readonly settings: OrphanImageExtensions,
		private readonly host: OrphanCleanupHost,
	) {}

	render() {
		this.contentEl.addClass('orphan-cleanup-panel');
		void this.scan();
	}

	private async scan() {
		this.scanning = true;
		this.selections.clear();
		this.linkSelections.clear();
		this.nativeSelections.clear();
		this.pages.clear();
		this.renderContents();
		try {
			this.candidates = await findCleanupCandidates(this.app, this.settings.orphanImageExtensions, this.settings.orphanIgnoredFolders);
		} catch (error) {
			new Notice(`扫描失败：${reasonFor(error)}`);
			this.candidates = { images: [], folders: [], brokenLinks: [], nativeLinks: [] };
		} finally {
			this.scanning = false;
			this.renderContents();
		}
	}

	private renderContents() {
		this.contentEl.empty();
		if (this.scanning) {
			this.contentEl.createSpan({ text: '正在扫描资料库…', cls: 'orphan-cleanup-scan-status' });
			return;
		}
		this.renderTabs();
		if (this.showHelp) this.renderHelp();
		if (this.processed) this.renderProcessedSummary();
		this.renderList();
		this.renderActions();
	}

	private renderTabs() {
		const tabs = this.contentEl.createDiv({ cls: 'orphan-cleanup-tabs' });
		for (const [tab, label, count] of [
			['images', '孤立图片', this.candidates.images.length],
			['broken-links', '失效图片链接', this.candidates.brokenLinks.length],
			['native-links', '原生图片链接', this.candidates.nativeLinks.length],
			['folders', '空文件夹', this.candidates.folders.length],
		] as const) {
			const button = tabs.createEl('button', {
				text: `${label}（${count}）`,
				cls: tab === this.activeTab ? 'orphan-cleanup-tab is-active' : 'orphan-cleanup-tab',
			});
			button.dataset.tab = tab;
			button.addEventListener('click', () => {
				this.activeTab = tab;
				this.renderContents();
			});
		}
		const help = tabs.createEl('button', { text: '!', cls: 'orphan-cleanup-help-button' });
		help.type = 'button';
		help.title = '查看使用说明';
		help.setAttribute('aria-label', '查看使用说明');
		help.setAttribute('aria-expanded', String(this.showHelp));
		help.addEventListener('click', () => {
			this.showHelp = !this.showHelp;
			this.renderContents();
		});
	}

	private renderHelp() {
		const help = this.contentEl.createDiv({ cls: 'orphan-cleanup-help' });
		help.createEl('strong', { text: '使用说明' });
		help.createSpan({ text: '未勾选的项目不会被处理；确认后会移入 Obsidian 回收站。' });
	}

	private renderProcessedSummary() {
		const summary = this.contentEl.createDiv({ cls: 'orphan-cleanup-result-summary' });
		summary.setAttribute('role', 'status');
		const failed = this.processed?.failed ?? [];
		summary.createEl('strong', { text: '最近一次处理：' });
		summary.createSpan({ text: `成功 ${this.processed?.success ?? 0}，跳过 ${this.processed?.skipped ?? 0}，失败 ${failed.length}` });
		if (failed.length) summary.createDiv({ text: failed.map((item) => `${item.path}（${item.reason}）`).join('、') });
	}

	private renderList() {
		const currentTab = this.activeTab;
		const list = this.contentEl.createDiv({ cls: 'orphan-cleanup-list' });
		const toolbar = list.createDiv({ cls: 'orphan-cleanup-toolbar' });
		const content = list.createDiv({ cls: 'orphan-cleanup-scroll' });
		this.addRefreshControl(toolbar);
		this.addReportControls(toolbar);
		if (this.activeTab === 'images') this.addImageGroupingControl(toolbar);

		if (currentTab === 'broken-links' || currentTab === 'native-links') {
			const native = currentTab === 'native-links';
			const candidates = native ? this.candidates.nativeLinks : this.candidates.brokenLinks;
			const page = this.pageFor(currentTab, candidates.length);
			const pageItems = candidates.slice(page * CLEANUP_PAGE_SIZE, (page + 1) * CLEANUP_PAGE_SIZE);
			this.addSelectionControls(toolbar, pageItems.length, candidates.length,
				() => pageItems.forEach((item) => native ? this.nativeSelections.add(nativeImageLinkKey(item)) : this.linkSelections.add(brokenLinkKey(item))),
				() => candidates.forEach((item) => {
					if (native) {
						if (convertNativeImageLink(item)) this.nativeSelections.add(nativeImageLinkKey(item));
					} else {
						this.linkSelections.add(brokenLinkKey(item));
					}
				}),
				() => pageItems.forEach((item) => native ? this.nativeSelections.delete(nativeImageLinkKey(item)) : this.linkSelections.delete(brokenLinkKey(item))),
				() => { native ? this.nativeSelections.clear() : this.linkSelections.clear(); },
				() => { this.syncPageCheckboxes(content, true); this.updateSelectionSummary(); },
				() => { this.syncPageCheckboxes(content, false); this.updateSelectionSummary(); });
			if (candidates.length === 0) {
				content.createEl('p', { text: native ? '没有发现原生图片链接。' : '没有发现失效图片链接。', cls: 'orphan-cleanup-empty' });
				return;
			}
			native ? this.renderNativeLinkList(content, pageItems) : this.renderBrokenLinkList(content, pageItems);
			this.renderPagination(toolbar, candidates.length, page, (next) => { this.pages.set(currentTab, next); this.renderContents(); });
			return;
		}

		const items = this.itemsForActiveTab();
		const page = this.pageFor(currentTab, items.length);
		const pageItems = items.slice(page * CLEANUP_PAGE_SIZE, (page + 1) * CLEANUP_PAGE_SIZE);
		this.addSelectionControls(toolbar, pageItems.length, items.length,
			() => pageItems.forEach((item) => this.selections.add(item.path)),
			() => items.forEach((item) => this.selections.add(item.path)),
			() => pageItems.forEach((item) => this.selections.delete(item.path)),
			() => this.selections.clear(),
			() => { this.syncPageCheckboxes(content, true); this.updateSelectionSummary(); },
			() => { this.syncPageCheckboxes(content, false); this.updateSelectionSummary(); });

		if (items.length === 0) {
			content.createEl('p', {
				text: this.activeTab === 'images'
					? '没有发现孤立图片。'
					: '没有发现可递归清理的空文件夹。',
				cls: 'orphan-cleanup-empty',
			});
			return;
		}

		if (currentTab === 'images') {
			this.renderImageGrid(content, pageItems.filter((item): item is TFile => item instanceof TFile), items as TFile[]);
			this.renderPagination(toolbar, items.length, page, (next) => { this.pages.set(currentTab, next); this.renderContents(); });
			return;
		}

		const table = content.createEl('table', { cls: 'orphan-cleanup-table' });
		const header = table.createEl('thead').createEl('tr');
		header.createEl('th', { text: '选择' });
		if (this.activeTab === 'images') header.createEl('th', { text: '预览' });
		header.createEl('th', { text: this.activeTab === 'images' ? '图片' : '文件夹' });
		header.createEl('th', { text: this.activeTab === 'images' ? '大小' : '说明' });
		const body = table.createEl('tbody');
		for (const group of this.groupedItems(pageItems)) {
			if (group.label) {
				const groupRow = body.createEl('tr', { cls: 'orphan-cleanup-group' });
				groupRow.createEl('td', { text: `${group.label}（${group.items.length}）`, attr: { colspan: this.activeTab === 'images' ? '4' : '3' } });
			}
			for (const item of group.items) this.renderItemRow(body, item);
		}
		this.renderPagination(toolbar, items.length, page, (next) => { this.pages.set(currentTab, next); this.renderContents(); });
	}

	private addSelectionControls(
		container: HTMLElement,
		pageCount: number,
		totalCount: number,
		selectPage: () => void,
		selectAll: () => void,
		clearPage: () => void,
		clearAll: () => void,
		refreshPage: () => void,
		refreshAfterClear: () => void,
	) {
		const selectPageButton = container.createEl('button', { text: '全选当前页' });
		selectPageButton.disabled = pageCount === 0;
		selectPageButton.addEventListener('click', () => { selectPage(); refreshPage(); });
		const selectAllButton = container.createEl('button', { text: '全选全部' });
		selectAllButton.disabled = totalCount === 0;
		selectAllButton.addEventListener('click', () => { selectAll(); refreshPage(); });
		const clearPageButton = container.createEl('button', { text: '取消当前页选择' });
		clearPageButton.disabled = pageCount === 0;
		clearPageButton.addEventListener('click', () => { clearPage(); refreshAfterClear(); });
		const clearAllButton = container.createEl('button', { text: '取消全部选择' });
		clearAllButton.disabled = totalCount === 0;
		clearAllButton.addEventListener('click', () => { clearAll(); refreshAfterClear(); });
	}

	private syncPageCheckboxes(list: HTMLElement, checked: boolean) {
		for (const checkbox of Array.from(list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
			if (!checkbox.disabled) checkbox.checked = checked;
		}
	}

	private pageFor(tab: string, total: number) {
		const last = Math.max(0, Math.ceil(total / CLEANUP_PAGE_SIZE) - 1);
		const page = Math.min(this.pages.get(tab) ?? 0, last);
		this.pages.set(tab, page);
		return page;
	}

	private renderPagination(container: HTMLElement, total: number, page: number, onChange: (page: number) => void) {
		const pageCount = Math.ceil(total / CLEANUP_PAGE_SIZE);
		if (total === 0) return;
		const pagination = container.createDiv({ cls: 'orphan-cleanup-pagination' });
		const previous = pagination.createEl('button', { text: '上一页' });
		previous.disabled = page === 0;
		previous.addEventListener('click', () => onChange(page - 1));
		pagination.createSpan({ text: `第 ${page + 1} / ${pageCount} 页（共 ${total} 项）` });
		const next = pagination.createEl('button', { text: '下一页' });
		next.disabled = page === pageCount - 1;
		next.addEventListener('click', () => onChange(page + 1));
	}

	private addRefreshControl(container: HTMLElement) {
		const refresh = container.createEl('button', { text: '刷新' });
		refresh.title = '重新扫描当前清理窗口';
		refresh.addEventListener('click', () => void this.scan());
	}

	private addReportControls(container: HTMLElement) {
		const report = () => buildCleanupReport({ generatedAt: new Date().toLocaleString('zh-CN'), images: this.candidates.images.map((item) => item.path), folders: this.candidates.folders.map((item) => item.path), brokenLinks: this.candidates.brokenLinks.map(({ sourcePath, original, linkPath }) => ({ sourcePath, original, linkPath })), nativeLinks: this.candidates.nativeLinks.map((item) => ({ sourcePath: item.sourcePath, original: item.original, status: convertNativeImageLink(item) ?? item.reason ?? '未解析目标' })), processed: this.processed });
		const copy = container.createEl('button', { text: '复制报告' });
		copy.addEventListener('click', () => void (async () => { try { await navigator.clipboard.writeText(report()); new Notice('报告已复制。'); } catch (error) { new Notice(`复制报告失败：${reasonFor(error)}`); } })());
		const exportButton = container.createEl('button', { text: '导出报告' });
		exportButton.addEventListener('click', () => void this.exportReport(report()));
	}

	private async exportReport(content: string) {
		const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
		const base = `related-operations-report-${stamp}`;
		let path = `${base}.md`; let index = 2;
		while (this.app.vault.getAbstractFileByPath(path)) path = `${base}-${index++}.md`;
		try { await this.app.vault.create(path, content); new Notice(`报告已导出：${path}`); } catch (error) { new Notice(`导出报告失败：${reasonFor(error)}`); }
	}

	private renderBrokenLinkList(container: HTMLElement, links: BrokenImageLink[]) {
		const table = container.createEl('table', { cls: 'orphan-cleanup-table' });
		const header = table.createEl('thead').createEl('tr');
		header.createEl('th', { text: '选择' });
		header.createEl('th', { text: '源笔记' });
		header.createEl('th', { text: '失效链接' });
		header.createEl('th', { text: '未解析目标' });
		header.createEl('th', { text: '操作' });
		const body = table.createEl('tbody');
		for (const link of links) this.renderBrokenLinkRow(body, link);
	}

	private renderNativeLinkList(container: HTMLElement, links: NativeImageLink[]) {
		const table = container.createEl('table', { cls: 'orphan-cleanup-table' });
		const header = table.createEl('thead').createEl('tr');
		for (const text of ['选择', '源笔记', '原生链接', '目标/状态', '操作']) header.createEl('th', { text });
		const body = table.createEl('tbody');
		for (const link of links) {
			const row = body.createEl('tr');
			const checkbox = row.createEl('td').createEl('input', { type: 'checkbox' });
			checkbox.checked = this.nativeSelections.has(nativeImageLinkKey(link));
			checkbox.disabled = !convertNativeImageLink(link);
			checkbox.addEventListener('change', () => { if (checkbox.checked) this.nativeSelections.add(nativeImageLinkKey(link)); else this.nativeSelections.delete(nativeImageLinkKey(link)); this.updateSelectionSummary(); });
			const sourceCell = row.createEl('td', { cls: 'orphan-cleanup-path' });
			const source = sourceCell.createEl('a', { text: link.sourcePath, cls: 'orphan-cleanup-link' });
			source.addEventListener('click', (event) => {
				event.preventDefault();
				void this.app.workspace.openLinkText(link.sourcePath, '', 'tab');
			});
			row.createEl('td', { text: link.original, cls: 'orphan-cleanup-detail' });
			row.createEl('td', {
				text: convertNativeImageLink(link) ?? link.reason ?? '未解析目标',
				cls: 'orphan-cleanup-detail',
			});
			const locate = row.createEl('td').createEl('button', { text: '定位' });
			locate.addEventListener('click', () => void this.locateNativeLink(link));
		}
	}

	private async locateNativeLink(link: NativeImageLink) {
		await this.app.workspace.openLinkText(link.sourcePath, '', false, { state: { mode: 'source' } });
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const range = nativeImageLinkOffset(view.editor.getValue(), link);
		if (!range) { new Notice('笔记内容已变化，请重新扫描。'); return; }
		const from = view.editor.offsetToPos(range.start); const to = view.editor.offsetToPos(range.end);
		view.editor.setSelection(from, to); view.editor.scrollIntoView({ from, to }, true);
	}

	private renderBrokenLinkRow(body: HTMLElement, link: BrokenImageLink) {
		const key = brokenLinkKey(link);
		const row = body.createEl('tr');
		const checkbox = row.createEl('td').createEl('input', { type: 'checkbox' });
		checkbox.checked = this.linkSelections.has(key);
		checkbox.setAttribute('aria-label', `选择 ${link.sourcePath} 中的失效图片链接`);
		checkbox.addEventListener('change', () => {
			if (checkbox.checked) this.linkSelections.add(key);
			else this.linkSelections.delete(key);
			this.updateSelectionSummary();
		});

		const sourceCell = row.createEl('td', { cls: 'orphan-cleanup-path' });
		const source = sourceCell.createEl('a', { text: link.sourcePath, cls: 'orphan-cleanup-link' });
		source.addEventListener('click', (event) => {
			event.preventDefault();
			void this.app.workspace.openLinkText(link.sourcePath, '', 'tab');
		});
		const linkCell = row.createEl('td', { cls: 'orphan-cleanup-detail' });
		linkCell.createEl('code', { text: link.original });
		row.createEl('td', { text: link.linkPath, cls: 'orphan-cleanup-detail' });
		const actionCell = row.createEl('td');
		const locate = actionCell.createEl('button', { text: '定位', cls: 'orphan-cleanup-locate' });
		locate.type = 'button';
		locate.title = '打开源笔记并选中此链接';
		locate.addEventListener('click', (event) => {
			event.preventDefault();
			void this.locateBrokenLink(link);
		});
	}

	private async locateBrokenLink(link: BrokenImageLink) {
		await this.app.workspace.openLinkText(link.sourcePath, '', false, { state: { mode: 'source' } });
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		let view = activeView?.file?.path === link.sourcePath ? activeView : null;
		if (!view) {
			for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
				const markdownView = leaf.view;
				if (markdownView instanceof MarkdownView && markdownView.file?.path === link.sourcePath) {
					await this.app.workspace.revealLeaf(leaf);
					view = markdownView;
					break;
				}
			}
		}
		if (!view) {
			new Notice('无法打开源笔记。');
			return;
		}

		const editor = view.editor;
		const range = findBrokenLinkOffset(editor.getValue(), link);
		if (!range) {
			new Notice('笔记内容已变化，请重新扫描。');
			return;
		}
		const from = editor.offsetToPos(range.start);
		const to = editor.offsetToPos(range.end);
		editor.setSelection(from, to);
		editor.scrollIntoView({ from, to }, true);
	}

	private renderImageGrid(container: HTMLElement, items: TFile[], allItems: TFile[]) {
		const grid = container.createDiv({ cls: 'orphan-cleanup-grid' });
		for (const group of this.groupedItems(items)) {
			if (group.label) grid.createEl('h3', { text: `${group.label}（${group.items.length}）`, cls: 'orphan-cleanup-grid-group' });
			const cards = grid.createDiv({ cls: 'orphan-cleanup-grid-items' });
			for (const item of group.items) {
				if (item instanceof TFile) this.renderImageCard(cards, item, allItems);
			}
		}
	}

	private renderImageCard(container: HTMLElement, file: TFile, items: TFile[]) {
		const card = container.createDiv({ cls: 'orphan-cleanup-image-card' });
		card.dataset.path = file.path;
		const header = card.createDiv({ cls: 'orphan-cleanup-image-card-header' });
		const checkbox = header.createEl('input', { type: 'checkbox' });
		checkbox.checked = this.selections.has(file.path);
		checkbox.setAttribute('aria-label', `选择 ${file.name}`);
		checkbox.addEventListener('change', () => {
			if (checkbox.checked) this.selections.add(file.path);
			else this.selections.delete(file.path);
			this.updateSelectionSummary();
		});
		const deleteButton = header.createEl('button', { text: '删除', cls: 'orphan-cleanup-image-delete' });
		deleteButton.type = 'button';
		deleteButton.title = '移入回收站';
		deleteButton.addEventListener('click', () => void this.trashSingleImage(file));
		const preview = card.createEl('img', { attr: { alt: `${file.name} 预览`, loading: 'lazy' } });
		preview.src = this.app.vault.getResourcePath(file);
		preview.title = '点击预览';
		preview.addEventListener('click', () => new ImagePreviewModal(this.app, items, items.indexOf(file), (deletedFile) => this.removeImage(deletedFile)).open());
		preview.addEventListener('error', () => {
			preview.replaceWith(card.createSpan({ text: '无法预览', cls: 'orphan-cleanup-preview-failed' }));
		});
		card.createEl('a', { text: file.name, cls: 'orphan-cleanup-image-name' }).addEventListener('click', (event) => {
			event.preventDefault();
			void this.app.workspace.openLinkText(file.path, '', 'tab');
		});
		card.createSpan({ text: formatBytes(file.stat.size), cls: 'orphan-cleanup-image-size' });
	}

	private async trashSingleImage(file: TFile) {
		if (!this.app.vault.getAbstractFileByPath(file.path)) return;
		try {
			await this.app.fileManager.trashFile(file);
			this.removeImage(file);
			new Notice(`已移入回收站：${file.name}`);
		} catch (error) {
			new Notice(`删除失败：${reasonFor(error)}`);
		}
	}

	private removeImage(file: TFile) {
		this.candidates.images = this.candidates.images.filter((item) => item.path !== file.path);
		this.candidates.folders = findRecursivelyEmptyFolders(this.app.vault.getRoot()).sort((a, b) => b.path.length - a.path.length || byPath(a, b));
		this.selections.delete(file.path);
		for (const card of Array.from(this.contentEl.querySelectorAll<HTMLElement>('.orphan-cleanup-image-card'))) {
			if (card.dataset.path === file.path) card.remove();
		}
		this.updateImageGroupCounts();
		this.updateTabCounts();
		this.updateSelectionSummary();
		if (this.candidates.images.length === 0) this.renderContents();
	}

	private updateTabCounts() {
		for (const [tab, label, count] of [
			['images', '孤立图片', this.candidates.images.length],
			['broken-links', '失效图片链接', this.candidates.brokenLinks.length],
			['folders', '空文件夹', this.candidates.folders.length],
			['native-links', '原生图片链接', this.candidates.nativeLinks.length],
		] as const) {
			this.contentEl.querySelector<HTMLElement>(`.orphan-cleanup-tab[data-tab="${tab}"]`)?.setText(`${label}（${count}）`);
		}
	}

	private updateImageGroupCounts() {
		for (const cards of Array.from(this.contentEl.querySelectorAll<HTMLElement>('.orphan-cleanup-grid-items'))) {
			const heading = cards.previousElementSibling;
			if (!(heading instanceof HTMLElement) || !heading.matches('.orphan-cleanup-grid-group')) continue;
			if (cards.children.length === 0) {
				heading.remove();
				cards.remove();
			} else {
				heading.setText(`${heading.textContent?.replace(/（\d+）$/, '')}（${cards.children.length}）`);
			}
		}
	}

	private addImageGroupingControl(container: HTMLElement) {
		const label = container.createEl('label', { cls: 'orphan-cleanup-grouping' });
		label.createSpan({ text: '分组：' });
		const select = label.createEl('select');
		for (const [value, text] of [
			['none', '不分组'],
			['path', '按路径'],
			['extension', '按格式'],
		] as const) {
			const option = select.createEl('option', { text, value });
			option.selected = value === this.imageGrouping;
		}
		select.addEventListener('change', () => {
			this.imageGrouping = select.value as ImageGrouping;
			this.renderContents();
		});
	}

	private groupedItems(items: TAbstractFile[]) {
		if (this.activeTab !== 'images' || this.imageGrouping === 'none') return [{ label: '', items }];
		const groups = new Map<string, TAbstractFile[]>();
		for (const item of items) {
			if (!(item instanceof TFile)) continue;
			const label = this.imageGrouping === 'path' ? parentFolder(item.path) || '根目录' : `.${item.extension.toUpperCase()}`;
			const group = groups.get(label) ?? [];
			group.push(item);
			groups.set(label, group);
		}
		return [...groups.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([label, grouped]) => ({ label, items: grouped.sort(byPath) }));
	}

	private renderItemRow(body: HTMLElement, item: TAbstractFile) {
		const row = body.createEl('tr');
		const checkbox = row.createEl('td').createEl('input', { type: 'checkbox' });
		checkbox.checked = this.selections.has(item.path);
		checkbox.addEventListener('change', () => {
			if (checkbox.checked) this.selections.add(item.path);
			else this.selections.delete(item.path);
			this.updateSelectionSummary();
		});
		if (item instanceof TFile) this.addImagePreview(row, item);
		const pathCell = row.createEl('td', { cls: 'orphan-cleanup-path' });
		const link = pathCell.createEl('a', { text: item.path, cls: 'orphan-cleanup-link' });
		link.addEventListener('click', (event) => {
			event.preventDefault();
			void this.app.workspace.openLinkText(item.path, '', 'tab');
		});
		row.createEl('td', {
			text: item instanceof TFile ? formatBytes(item.stat.size) : '仅包含空子文件夹或没有子项',
			cls: 'orphan-cleanup-detail',
		});
	}

	private addImagePreview(row: HTMLElement, file: TFile) {
		const cell = row.createEl('td', { cls: 'orphan-cleanup-preview' });
		const preview = cell.createEl('img', { attr: { alt: `${file.name} 预览`, loading: 'lazy' } });
		preview.src = this.app.vault.getResourcePath(file);
		preview.title = '点击放大预览';
		preview.addEventListener('click', () => new ImagePreviewModal(this.app, [file], 0).open());
		preview.addEventListener('error', () => {
			preview.replaceWith(cell.createSpan({ text: '无法预览', cls: 'orphan-cleanup-preview-failed' }));
		});
	}

	private renderActions() {
		const actions = this.contentEl.createDiv({ cls: 'orphan-cleanup-actions' });
		const summary = actions.createSpan({ cls: 'orphan-cleanup-summary' });
		summary.setAttribute('aria-live', 'polite');
		this.updateSelectionSummary(summary);
		const isLinkTab = this.activeTab === 'broken-links' || this.activeTab === 'native-links';
		const cleanup = actions.createEl('button', {
			text: this.activeTab === 'native-links' ? '转换选中链接' : isLinkTab ? '移除选中链接' : '移入回收站',
			cls: 'mod-cta',
		});
		cleanup.disabled = this.activeTab === 'broken-links' ? this.linkSelections.size === 0 : this.activeTab === 'native-links' ? this.nativeSelections.size === 0 : this.selections.size === 0;
		cleanup.addEventListener('click', () => void (this.activeTab === 'native-links' ? this.confirmConvertLinks() : isLinkTab ? this.confirmRemoveLinks() : this.confirmCleanup()));
	}

	private updateSelectionSummary(summary?: HTMLElement) {
		const target = summary ?? this.contentEl.querySelector<HTMLElement>('.orphan-cleanup-summary');
		if (!target) return;
		const images = this.candidates.images.filter((item) => this.selections.has(item.path)).length;
		const folders = this.candidates.folders.filter((item) => this.selections.has(item.path)).length;
		const links = this.candidates.brokenLinks.filter((item) => this.linkSelections.has(brokenLinkKey(item))).length;
		const native = this.candidates.nativeLinks.filter((item) => this.nativeSelections.has(nativeImageLinkKey(item))).length;
		target.setText(`已选：${images} 张图片，${links + native} 条链接，${folders} 个文件夹`);
		const action = this.contentEl.querySelector<HTMLButtonElement>('.orphan-cleanup-actions button.mod-cta');
		if (action) action.disabled = this.activeTab === 'broken-links' ? links === 0 : this.activeTab === 'native-links' ? native === 0 : images + folders === 0;
	}

	private itemsForActiveTab(): TAbstractFile[] {
		return this.activeTab === 'images' ? this.candidates.images : this.candidates.folders;
	}

	private async confirmCleanup() {
		const selectedImages = this.candidates.images.filter((item) => this.selections.has(item.path));
		const selectedFolders = this.candidates.folders.filter((item) => this.selections.has(item.path));
		if (selectedImages.length + selectedFolders.length === 0) return;
		const confirmed = await new CleanupConfirmationModal(this.app, selectedImages.length, selectedFolders.length).waitForConfirmation();
		if (!confirmed) return;
		const result = await trashSelected(this.app, selectedImages, selectedFolders);
		this.processed = { success: result.deleted.length, skipped: 0, failed: result.failed };
		const message = [`已移入回收站：${result.deleted.length}`, `失败：${result.failed.length}`];
		if (result.failed.length) message.push(result.failed.map((item) => `${item.path}（${item.reason}）`).join('、'));
		new Notice(message.join('\n'));
		await this.scan();
	}

	private async confirmRemoveLinks() {
		const selectedLinks = this.candidates.brokenLinks.filter((item) => this.linkSelections.has(brokenLinkKey(item)));
		if (selectedLinks.length === 0) return;
		const sourceCount = new Set(selectedLinks.map((item) => item.sourcePath)).size;
		const confirmed = await new RemoveBrokenLinksConfirmationModal(this.app, selectedLinks.length, sourceCount).waitForConfirmation();
		if (!confirmed) return;
		const result = await removeSelectedBrokenLinks(this.app, selectedLinks);
		this.processed = { success: result.removed, skipped: result.skipped, failed: result.failed };
		const message = [`已移除链接：${result.removed}`, `跳过：${result.skipped}`, `失败：${result.failed.length}`];
		if (result.failed.length) message.push(result.failed.map((item) => `${item.path}（${item.reason}）`).join('、'));
		new Notice(message.join('\n'));
		await this.scan();
	}

	private async confirmConvertLinks() {
		const selected = this.candidates.nativeLinks.filter((item) => this.nativeSelections.has(nativeImageLinkKey(item)));
		if (!selected.length) return;
		if (!await new ConvertNativeLinksConfirmationModal(this.app, selected.length).waitForConfirmation()) return;
		let converted = 0, skipped = 0, failed = 0;
		const failures: Array<{ path: string; reason: string }> = [];
		for (const [path, links] of new Map([...selected].reduce((map, link) => { const list = map.get(link.sourcePath) ?? []; list.push(link); map.set(link.sourcePath, list); return map; }, new Map<string, NativeImageLink[]>())) ) {
			const file = this.app.vault.getFileByPath(path);
			if (!file) { failed++; failures.push({ path, reason: '文件不存在' }); continue; }
			try { await this.app.vault.process(file, (content) => { const result = replaceNativeImageLinks(content, links); converted += result.converted; skipped += result.skipped; return result.content; }); } catch (error) { failed++; failures.push({ path, reason: reasonFor(error) }); }
		}
		this.processed = { success: converted, skipped, failed: failures };
		new Notice(`已转换：${converted}，跳过：${skipped}，失败：${failed}`);
		await this.scan();
	}
}

export class OrphanCleanupModal extends Modal {
	private panel?: OrphanCleanupPanel;

	constructor(app: App, private readonly settings: OrphanImageExtensions) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('orphan-cleanup-dialog');
		this.titleEl.setText('清理孤立资源');
		this.panel = new OrphanCleanupPanel(this.app, this.contentEl, this.settings, this);
		this.panel.render();
	}

	onClose() {
		this.modalEl.removeClass('orphan-cleanup-dialog');
		this.panel = undefined;
		this.contentEl.empty();
	}
}

async function findCleanupCandidates(app: App, imageExtensions: string, ignoredFoldersValue = ''): Promise<CleanupCandidates> {
	const extensions = parseExtensions(imageExtensions);
	const ignoredFolders = parseIgnoredFolders(ignoredFoldersValue);
	const images = app.vault.getFiles().filter((file) => extensions.has(file.extension.toLowerCase()) && !isIgnoredPath(file.path, ignoredFolders));
	const referenced = new Set<string>();
	for (const [sourcePath, destinations] of Object.entries(app.metadataCache.resolvedLinks)) {
		if (!sourcePath.toLowerCase().endsWith('.md')) continue;
		for (const path of Object.keys(destinations)) referenced.add(path);
	}
	for (const canvas of app.vault.getFiles().filter((file) => file.extension.toLowerCase() === 'canvas')) {
		for (const path of await referencedByCanvas(app, canvas)) referenced.add(path);
	}
	// Conservative textual pass: HTML image tags, frontmatter path values, and
	// code-block text do not appear in resolvedLinks. Any textual mention of the
	// file name or path counts as a reference so that such images are never
	// flagged as orphans.
	await markImagesReferencedByText(app, images, referenced);
	return {
		images: images.filter((file) => !referenced.has(file.path)).sort(byPath),
		folders: findRecursivelyEmptyFolders(app.vault.getRoot(), ignoredFolders).sort((a, b) => b.path.length - a.path.length || byPath(a, b)),
		brokenLinks: findBrokenImageLinks(app, imageExtensions),
		nativeLinks: findNativeImageLinks(app, imageExtensions),
	};
}

async function markImagesReferencedByText(app: App, images: TFile[], referenced: Set<string>): Promise<void> {
	const remaining = images.filter((image) => !referenced.has(image.path));
	if (remaining.length === 0) return;
	const byBasename = new Map<string, string[]>();
	const byPath = new Map<string, string>();
	const exoticNames: string[] = [];
	for (const image of remaining) {
		const key = image.name.toLowerCase();
		const paths = byBasename.get(key) ?? [];
		paths.push(image.path);
		byBasename.set(key, paths);
		byPath.set(image.path.toLowerCase(), image.path);
		if (needsRawTextSearch(image.name)) exoticNames.push(key);
	}
	for (const file of app.vault.getMarkdownFiles()) {
		const content = await app.vault.cachedRead(file);
		for (const token of pathLikeTokens(content)) {
			for (const candidate of pathTokenCandidates(token.replace(/^[./\\]+/, ''))) {
				const direct = byPath.get(candidate);
				if (direct) referenced.add(direct);
				const matches = byBasename.get(lastPathSegment(candidate));
				if (matches) for (const path of matches) referenced.add(path);
			}
		}
		for (let index = exoticNames.length - 1; index >= 0; index--) {
			const key = exoticNames[index]!;
			if (!content.toLowerCase().includes(key)) continue;
			for (const path of byBasename.get(key) ?? []) referenced.add(path);
			exoticNames.splice(index, 1);
		}
		if (referenced.size >= images.length) return;
	}
}

async function referencedByCanvas(app: App, canvas: TFile): Promise<string[]> {
	try {
		const content = JSON.parse(await app.vault.read(canvas)) as { nodes?: Array<{ file?: unknown }> };
		return (content.nodes ?? []).flatMap((node) => {
			if (typeof node.file !== 'string') return [];
			const file = app.metadataCache.getFirstLinkpathDest(node.file, canvas.path);
			return file instanceof TFile ? [file.path] : [];
		});
	} catch {
		return [];
	}
}

function findRecursivelyEmptyFolders(folder: TFolder, ignoredFolders: string[] = []): TFolder[] {
	const candidates: TFolder[] = [];
	const visit = (current: TFolder): boolean => {
		// Hidden folders such as .obsidian, .trash, and .git are system folders:
		// never candidates, and they block their parent from being listed as empty.
		if (hasHiddenPathSegment(current.path)) return false;
		if (isIgnoredPath(current.path, ignoredFolders)) return false;
		let onlyEmptyFolders = true;
		for (const child of current.children) {
			if (child instanceof TFolder) {
				if (!visit(child)) onlyEmptyFolders = false;
			} else {
				onlyEmptyFolders = false;
			}
		}
		if (onlyEmptyFolders && current.path) candidates.push(current);
		return onlyEmptyFolders;
	};
	visit(folder);
	return candidates;
}

function lastPathSegment(path: string) {
	const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return index >= 0 ? path.slice(index + 1) : path;
}

async function trashSelected(app: App, images: TFile[], folders: TFolder[]): Promise<CleanupResult> {
	const result: CleanupResult = { deleted: [], failed: [] };
	const moveToLocalTrash = app.fileManager.trashFile.bind(app.fileManager);
	for (const item of [...images, ...folders.sort((a, b) => b.path.length - a.path.length)]) {
		if (!app.vault.getAbstractFileByPath(item.path)) continue;
		try {
			await moveToLocalTrash(item);
			result.deleted.push(item.path);
		} catch (error) {
			result.failed.push({ path: item.path, reason: reasonFor(error) });
		}
	}
	return result;
}

function byPath(a: TAbstractFile, b: TAbstractFile) {
	return a.path.localeCompare(b.path);
}

function parentFolder(path: string) {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function reasonFor(error: unknown) {
	return error instanceof Error ? error.message : '未知错误';
}

class CleanupConfirmationModal extends Modal {
	private resolver?: (confirmed: boolean) => void;
	private settled = false;

	constructor(app: App, private readonly imageCount: number, private readonly folderCount: number) {
		super(app);
	}

	waitForConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolver = resolve;
			this.open();
		});
	}

	onOpen() {
		this.titleEl.setText('确认移入回收站');
		this.contentEl.createEl('p', { text: `即将移入 Obsidian 回收站：${this.imageCount} 张图片、${this.folderCount} 个文件夹。` });
		this.contentEl.createEl('p', { text: '这不会永久删除文件，可在 Obsidian 回收站中恢复。', cls: 'orphan-cleanup-warning' });
		const actions = this.contentEl.createDiv({ cls: 'orphan-cleanup-actions' });
		const confirm = actions.createEl('button', { text: '确认移入回收站', cls: 'mod-cta' });
		confirm.addEventListener('click', () => this.finish(true));
		const cancel = actions.createEl('button', { text: '取消' });
		cancel.addEventListener('click', () => this.finish(false));
	}

	onClose() {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.resolver?.(false);
		}
	}

	private finish(confirmed: boolean) {
		if (this.settled) return;
		this.settled = true;
		this.resolver?.(confirmed);
		this.close();
	}
}

class RemoveBrokenLinksConfirmationModal extends Modal {
	private resolver?: (confirmed: boolean) => void;
	private settled = false;

	constructor(app: App, private readonly linkCount: number, private readonly sourceCount: number) {
		super(app);
	}

	waitForConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolver = resolve;
			this.open();
		});
	}

	onOpen() {
		this.titleEl.setText('确认移除链接');
		this.contentEl.createEl('p', { text: `即将修改 ${this.sourceCount} 篇笔记，移除 ${this.linkCount} 条失效图片链接。` });
		this.contentEl.createEl('p', { text: '这会直接修改 Markdown 内容，不会移入回收站。', cls: 'orphan-cleanup-warning' });
		const actions = this.contentEl.createDiv({ cls: 'orphan-cleanup-actions' });
		const confirm = actions.createEl('button', { text: '确认移除链接', cls: 'mod-cta' });
		confirm.addEventListener('click', () => this.finish(true));
		const cancel = actions.createEl('button', { text: '取消' });
		cancel.addEventListener('click', () => this.finish(false));
	}

	onClose() {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.resolver?.(false);
		}
	}

	private finish(confirmed: boolean) {
		if (this.settled) return;
		this.settled = true;
		this.resolver?.(confirmed);
		this.close();
	}
}

class ConvertNativeLinksConfirmationModal extends Modal {
	private resolver?: (confirmed: boolean) => void;
	private settled = false;
	constructor(app: App, private readonly count: number) { super(app); }
	waitForConfirmation() { return new Promise<boolean>((resolve) => { this.resolver = resolve; this.open(); }); }
	onOpen() {
		this.titleEl.setText('确认转换图片链接');
		this.contentEl.createEl('p', { text: `即将转换 ${this.count} 条原生图片链接。` });
		this.contentEl.createEl('p', { text: '尺寸参数和无法解析的链接会跳过；已转换内容可用编辑历史撤销。', cls: 'orphan-cleanup-warning' });
		const actions = this.contentEl.createDiv({ cls: 'orphan-cleanup-actions' });
		actions.createEl('button', { text: '确认转换', cls: 'mod-cta' }).addEventListener('click', () => this.finish(true));
		actions.createEl('button', { text: '取消' }).addEventListener('click', () => this.finish(false));
	}
	onClose() { this.contentEl.empty(); if (!this.settled) { this.settled = true; this.resolver?.(false); } }
	private finish(value: boolean) { if (this.settled) return; this.settled = true; this.resolver?.(value); this.close(); }
}

class ImagePreviewModal extends Modal {
	private index: number;
	private imageEl!: HTMLImageElement;
	private pathEl!: HTMLElement;
	private previousButton!: HTMLButtonElement;
	private nextButton!: HTMLButtonElement;

	constructor(
		app: App,
		private readonly files: TFile[],
		index: number,
		private readonly onDeleted?: (file: TFile) => void,
	) {
		super(app);
		this.index = index;
	}

	onOpen() {
		this.modalEl.addClass('orphan-cleanup-preview-dialog');
		this.contentEl.addClass('orphan-cleanup-preview-modal');
		const frame = this.contentEl.createDiv({ cls: 'orphan-cleanup-preview-frame' });
		this.imageEl = frame.createEl('img', { cls: 'orphan-cleanup-full-preview is-auto-fit' });
		this.imageEl.addEventListener('error', () => frame.addClass('is-error'));
		this.pathEl = this.contentEl.createEl('p', { cls: 'orphan-cleanup-preview-path' });
		const actions = this.contentEl.createDiv({ cls: 'orphan-cleanup-preview-actions' });
		this.previousButton = actions.createEl('button', { text: '上一张' });
		this.previousButton.addEventListener('click', () => this.navigate(-1));
		this.nextButton = actions.createEl('button', { text: '下一张' });
		this.nextButton.addEventListener('click', () => this.navigate(1));
		const open = actions.createEl('button', { text: '打开文件' });
		open.addEventListener('click', () => void this.openCurrentFile());
		const openFolder = actions.createEl('button', { text: '打开所在文件夹' });
		openFolder.addEventListener('click', () => this.openCurrentFolder());
		const remove = actions.createEl('button', { text: '删除', cls: 'mod-warning' });
		remove.addEventListener('click', () => {
			const file = this.files[this.index];
			if (file) void this.trashCurrent(file);
		});
		this.scope.register(null, 'ArrowLeft', () => { this.navigate(-1); return false; });
		this.scope.register(null, 'ArrowRight', () => { this.navigate(1); return false; });
		this.updatePreview();
	}

	onClose() {
		this.contentEl.empty();
	}

	private navigate(offset: number) {
		const nextIndex = this.index + offset;
		if (nextIndex < 0 || nextIndex >= this.files.length) return;
		this.index = nextIndex;
		this.updatePreview();
	}

	private updatePreview() {
		const file = this.files[this.index];
		if (!file) return this.close();
		this.titleEl.setText(`${file.name}（${this.index + 1}/${this.files.length}）`);
		this.imageEl.alt = file.name;
		this.imageEl.parentElement?.removeClass('is-error');
		this.imageEl.src = this.app.vault.getResourcePath(file);
		this.pathEl.setText(file.path);
		this.previousButton.disabled = this.index === 0;
		this.nextButton.disabled = this.index === this.files.length - 1;
	}

	private async openCurrentFile() {
		const file = this.files[this.index];
		if (file) await this.app.workspace.openLinkText(file.path, '', 'tab');
	}

	private openCurrentFolder() {
		const file = this.files[this.index];
		if (!file) return;
		if (!Platform.isDesktopApp || !(this.app.vault.adapter instanceof FileSystemAdapter)) {
			new Notice('仅桌面端的本地资料库支持打开所在文件夹。');
			return;
		}
		const electron = (window as Window & {
			require?: (module: string) => { shell?: { showItemInFolder(path: string): void } };
		}).require?.('electron');
		if (!electron?.shell) {
			new Notice('当前环境无法打开系统文件夹。');
			return;
		}
		electron.shell.showItemInFolder(`${this.app.vault.adapter.getBasePath()}/${file.path}`);
	}

	private async trashCurrent(file: TFile) {
		try {
			await this.app.fileManager.trashFile(file);
			new Notice(`已移入回收站：${file.name}`);
			this.onDeleted?.(file);
			this.close();
		} catch (error) {
			new Notice(`删除失败：${reasonFor(error)}`);
		}
	}
}
