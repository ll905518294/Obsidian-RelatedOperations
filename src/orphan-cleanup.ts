import { App, FileSystemAdapter, MarkdownView, Modal, Notice, Platform, TAbstractFile, TFile, TFolder, setIcon } from 'obsidian';
import { hasHiddenPathSegment, isFrontmatterOnly, isIgnoredPath, needsRawTextSearch, parseExtensions, parseIgnoredFolders, pathLikeTokens, pathTokenCandidates } from './core-utils';
import { buildCleanupReport } from './cleanup-report';
import { selectCurrentCleanupItems } from './cleanup-selection';
import { brokenLinkKey, findBrokenImageLinks, findBrokenLinkOffset, removeSelectedBrokenLinks, type BrokenImageLink } from './broken-image-links';
import { brokenNoteLinkKey, createMissingNotes, findBrokenNoteLinks, findBrokenNoteLinkOffset, removeSelectedBrokenNoteLinks, type BrokenNoteLink } from './broken-note-links';
import { convertNativeImageLink, findNativeImageLinks, nativeImageLinkKey, nativeImageLinkOffset, replaceNativeImageLinks, revalidateNativeImageLink, type NativeImageLink } from './native-image-links';
import { findDuplicateFiles, removeImageReferencesForFile, type DuplicateFileGroup } from './duplicate-files.ts';

type ImageGrouping = 'none' | 'path' | 'extension';
const CLEANUP_PAGE_SIZE = 100;
const COMMON_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico', 'tif', 'tiff', 'heic', 'heif']);

interface CleanupCandidates {
	images: TFile[];
	attachments: TFile[];
	emptyFiles: TFile[];
	folders: TFolder[];
	brokenLinks: BrokenImageLink[];
	nativeLinks: NativeImageLink[];
	brokenNoteLinks: BrokenNoteLink[];
	duplicates: DuplicateFileGroup[];
	duplicateWarnings: Array<{ path: string; reason: string }>;
}

interface CleanupResult {
	deleted: string[];
	skipped: string[];
	failed: Array<{ path: string; reason: string }>;
}

interface OrphanImageExtensions {
	orphanImageExtensions: string;
	orphanIgnoredFolders: string;
}

type ScanStage = { label: string; state: 'pending' | 'scanning' | 'done'; elapsedMs: number; startedAt?: number };
type ScanProgress = { stage: number; processed: number; total: number; currentFile?: string };
type CleanupTab = 'overview' | 'images' | 'attachments' | 'broken-links' | 'native-links' | 'broken-note-links' | 'empty-files' | 'folders' | 'duplicates';

export interface OrphanCleanupHost {
	close(): void;
}

export class OrphanCleanupPanel {
	private candidates: CleanupCandidates = { images: [], attachments: [], emptyFiles: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], duplicates: [], duplicateWarnings: [] };
	private selections = new Set<string>();
	private linkSelections = new Set<string>();
	private nativeSelections = new Set<string>();
	private noteLinkSelections = new Set<string>();
	private activeTab: CleanupTab = 'overview';
	private imageGrouping: ImageGrouping = 'none';
	private attachmentGrouping: ImageGrouping = 'none';
	private scanning = false;
	private hasScanned = false;
	private scanStages: ScanStage[] = [];
	private scanProgress: ScanProgress = { stage: 0, processed: 0, total: 0 };
	private scanGeneration = 0;
	private scanStartedAt = 0;
	private scanElapsedMs = 0;
	private scanTimer = 0;
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
		this.renderContents();
	}

	dispose() {
		this.scanGeneration++;
		this.scanning = false;
		window.clearInterval(this.scanTimer);
		this.scanTimer = 0;
	}

	private async scan(preserveProcessed = false) {
		const generation = ++this.scanGeneration;
		if (!preserveProcessed) this.processed = undefined;
		this.scanning = true;
		this.scanStartedAt = performance.now();
		this.scanElapsedMs = 0;
		window.clearInterval(this.scanTimer);
		this.scanTimer = window.setInterval(() => {
			if (!this.scanning) return;
			this.scanElapsedMs = performance.now() - this.scanStartedAt;
			const elapsed = this.contentEl.querySelector<HTMLElement>('.orphan-cleanup-scan-elapsed');
			if (elapsed) elapsed.setText(`用时 ${formatScanDuration(this.scanElapsedMs)}`);
			this.updateScanStageRows();
		}, 250);
		this.selections.clear();
		this.linkSelections.clear();
		this.nativeSelections.clear();
		this.noteLinkSelections.clear();
		this.pages.clear();
		const startedAt = performance.now();
		this.scanStages = ['扫描资料库文件', '分析引用关系', '检查文本引用', '检查空文件与文件夹', '检查链接健康度', '检查重复文件'].map((label, index) => ({ label, state: index === 0 ? 'scanning' : 'pending', elapsedMs: 0, startedAt: index === 0 ? startedAt : undefined }));
		this.scanProgress = { stage: 0, processed: 0, total: 0 };
		this.renderContents();
		try {
			const candidates = await findCleanupCandidates(this.app, this.settings.orphanImageExtensions, this.settings.orphanIgnoredFolders, (progress) => {
				if (generation !== this.scanGeneration) return;
				const stageChanged = this.scanProgress.stage !== progress.stage;
				const previousStage = this.scanProgress.stage;
				this.scanProgress = progress;
				if (stageChanged) {
					const now = performance.now();
					const previous = this.scanStages[previousStage];
					if (previous?.startedAt) previous.elapsedMs = now - previous.startedAt;
					const current = this.scanStages[progress.stage];
					if (current && !current.startedAt) current.startedAt = now;
					this.scanStages.forEach((item, index) => { item.state = index < progress.stage ? 'done' : index === progress.stage ? 'scanning' : 'pending'; });
					this.updateScanStageRows();
				}
				this.updateScanProgress();
			});
			if (generation !== this.scanGeneration) return;
			this.candidates = candidates;
			this.hasScanned = true;
			this.renderContents();
		} catch (error) {
			if (generation !== this.scanGeneration) return;
			new Notice(`扫描失败：${reasonFor(error)}`);
			this.candidates = { images: [], attachments: [], emptyFiles: [], folders: [], brokenLinks: [], nativeLinks: [], brokenNoteLinks: [], duplicates: [], duplicateWarnings: [] };
			this.hasScanned = false;
			this.renderContents();
		} finally {
			if (generation === this.scanGeneration) {
				this.scanning = false;
				this.scanElapsedMs = performance.now() - this.scanStartedAt;
				window.clearInterval(this.scanTimer);
				const now = performance.now();
				const current = this.scanStages[this.scanProgress.stage];
				if (current?.startedAt) current.elapsedMs = now - current.startedAt;
				this.scanStages.forEach((item) => { item.state = 'done'; });
				this.updateScanStageRows();
				this.renderContents();
			}
		}
	}

	private renderContents() {
		this.contentEl.empty();
		if (this.scanning) {
			this.renderScanDashboard();
			return;
		}
		if (!this.hasScanned) {
			this.renderTabs();
			this.renderScanWelcome();
			return;
		}
		this.renderTabs();
		if (this.showHelp) this.renderHelp();
		if (this.processed) this.renderProcessedSummary();
		if (this.activeTab === 'overview') {
			this.renderOverview();
			return;
		}
		this.renderList();
		this.renderActions();
	}

	private renderScanWelcome() {
		const hero = this.contentEl.createDiv({ cls: 'orphan-cleanup-scan-hero' });
		hero.createDiv({ cls: 'orphan-cleanup-scan-shield', text: '✓' });
		hero.createEl('h2', { text: 'Vault 安全体检' });
		hero.createEl('p', { text: '扫描未引用文件、失效链接和可清理项目。扫描只在本地进行，不会修改任何文件。' });
		const button = hero.createEl('button', { text: '开始扫描', cls: 'mod-cta orphan-cleanup-start' });
		button.addEventListener('click', () => void this.scan());
		hero.createDiv({ cls: 'orphan-cleanup-scan-hint', text: '预计需要一点时间，取决于资料库大小' });
	}

	private renderScanDashboard() {
		const dashboard = this.contentEl.createDiv({ cls: 'orphan-cleanup-scan-dashboard' });
		dashboard.createDiv({ cls: 'orphan-cleanup-scan-orb', text: '⌁' });
		dashboard.createEl('h2', { text: '正在体检资料库…' });
		dashboard.createEl('p', { text: '扫描完成后会直接显示可处理的问题。', cls: 'orphan-cleanup-scan-detail' });
		dashboard.createDiv({ text: `用时 ${formatScanDuration(this.scanElapsedMs)}`, cls: 'orphan-cleanup-scan-elapsed' });
		const progress = dashboard.createDiv({ cls: 'orphan-cleanup-scan-progress' });
		progress.createDiv({ cls: 'orphan-cleanup-scan-progress-track' }).createDiv({ cls: 'orphan-cleanup-scan-progress-bar' });
		progress.createDiv({ cls: 'orphan-cleanup-scan-progress-meta' });
		progress.createDiv({ cls: 'orphan-cleanup-scan-current-file' });
		const list = dashboard.createDiv({ cls: 'orphan-cleanup-scan-stages' });
		for (const stage of this.scanStages) {
			const row = list.createDiv({ cls: `orphan-cleanup-scan-stage is-${stage.state}` });
			row.dataset.stageIndex = String(this.scanStages.indexOf(stage));
			row.createSpan({ cls: 'orphan-cleanup-scan-stage-icon', text: stage.state === 'done' ? '✓' : stage.state === 'scanning' ? '…' : '○' });
			row.createSpan({ cls: 'orphan-cleanup-scan-stage-label', text: stage.label });
			row.createSpan({ cls: 'orphan-cleanup-scan-stage-duration', text: formatScanDuration(stage.elapsedMs) });
			row.createSpan({ cls: 'orphan-cleanup-scan-stage-state', text: stage.state === 'done' ? '完成' : stage.state === 'scanning' ? '扫描中' : '等待中' });
		}
		this.updateScanProgress();
	}

	private updateScanProgress() {
		if (!this.scanning) return;
		const { processed, total, stage, currentFile } = this.scanProgress;
		const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
		const bar = this.contentEl.querySelector<HTMLElement>('.orphan-cleanup-scan-progress-bar');
		if (bar) bar.style.width = `${percent}%`;
		this.contentEl.querySelector<HTMLElement>('.orphan-cleanup-scan-progress-meta')?.setText(`${this.scanStages[stage]?.label ?? '扫描中'}：${processed}/${total || '…'}（${percent}%）`);
		this.contentEl.querySelector<HTMLElement>('.orphan-cleanup-scan-current-file')?.setText(currentFile ? `当前文件：${currentFile}` : '正在准备扫描…');
	}

	private updateScanStageRows() {
		const now = performance.now();
		for (const row of Array.from(this.contentEl.querySelectorAll<HTMLElement>('.orphan-cleanup-scan-stage'))) {
			const index = Number(row.dataset.stageIndex);
			const stage = this.scanStages[index];
			if (!stage) continue;
			const elapsedMs = stage.state === 'scanning' && stage.startedAt ? now - stage.startedAt : stage.elapsedMs;
			row.className = `orphan-cleanup-scan-stage is-${stage.state}`;
			row.querySelector('.orphan-cleanup-scan-stage-icon')?.setText(stage.state === 'done' ? '✓' : stage.state === 'scanning' ? '…' : '○');
			row.querySelector('.orphan-cleanup-scan-stage-duration')?.setText(formatScanDuration(elapsedMs));
			row.querySelector('.orphan-cleanup-scan-stage-state')?.setText(stage.state === 'done' ? '完成' : stage.state === 'scanning' ? '扫描中' : '等待中');
		}
	}

	private renderOverview() {
		const total = this.candidates.images.length + this.candidates.attachments.length + this.candidates.emptyFiles.length + this.candidates.folders.length + this.candidates.brokenLinks.length + this.candidates.nativeLinks.length + this.candidates.brokenNoteLinks.length + this.candidates.duplicates.length;
		const overview = this.contentEl.createDiv({ cls: 'orphan-cleanup-overview' });
		overview.createEl('h2', { text: total ? '体检完成，发现可处理项目' : '体检完成，资料库状态良好' });
		overview.createEl('p', { text: `本次扫描用时 ${formatScanDuration(this.scanElapsedMs)}，共发现 ${total} 项结果。`, cls: 'orphan-cleanup-overview-detail' });
		const counts = overview.createDiv({ cls: 'orphan-cleanup-overview-counts' });
		for (const [label, count] of [['未引用图片', this.candidates.images.length], ['未引用附件', this.candidates.attachments.length], ['失效链接', this.candidates.brokenLinks.length + this.candidates.brokenNoteLinks.length], ['原生图片链接', this.candidates.nativeLinks.length], ['空文件/文件夹', this.candidates.emptyFiles.length + this.candidates.folders.length], ['重复文件组', this.candidates.duplicates.length]] as const) {
			const item = counts.createDiv({ cls: 'orphan-cleanup-overview-count' });
			item.createEl('strong', { text: String(count) });
			item.createSpan({ text: label });
		}
		const rescan = overview.createEl('button', { text: '重新扫描', cls: 'mod-cta' });
		rescan.addEventListener('click', () => void this.scan());
	}

	private renderTabs() {
		const tabs = this.contentEl.createDiv({ cls: 'orphan-cleanup-tabs' });
		for (const [tab, label, count] of [
			['overview', '体检首页', 0],
			['images', '未引用图片', this.candidates.images.length],
			['attachments', '未引用附件', this.candidates.attachments.length],
			['broken-links', '失效图片链接', this.candidates.brokenLinks.length],
			['native-links', '原生图片链接', this.candidates.nativeLinks.length],
			['broken-note-links', '失效笔记链接', this.candidates.brokenNoteLinks.length],
			['empty-files', '空文件', this.candidates.emptyFiles.length],
			['folders', '空文件夹', this.candidates.folders.length],
			['duplicates', '重复文件', this.candidates.duplicates.length],
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
		if (currentTab === 'duplicates') {
			if (this.candidates.duplicateWarnings.length) {
				content.createDiv({ text: `有 ${this.candidates.duplicateWarnings.length} 个文件读取失败，仅展示成功计算哈希的结果。`, cls: 'orphan-cleanup-warning' });
			}
			const page = this.pageFor(currentTab, this.candidates.duplicates.length);
			const pageItems = this.candidates.duplicates.slice(page * CLEANUP_PAGE_SIZE, (page + 1) * CLEANUP_PAGE_SIZE);
			if (!pageItems.length) content.createEl('p', { text: '没有发现重复文件。', cls: 'orphan-cleanup-empty' });
			else this.renderDuplicateGroups(content, pageItems);
			this.renderPagination(toolbar, this.candidates.duplicates.length, page, (next) => { this.pages.set(currentTab, next); this.renderContents(); });
			return;
		}
		if (this.activeTab === 'images' || this.activeTab === 'attachments') this.addGroupingControl(toolbar);

		if (currentTab === 'broken-links' || currentTab === 'native-links' || currentTab === 'broken-note-links') {
			const native = currentTab === 'native-links';
			const note = currentTab === 'broken-note-links';
			const candidates = note ? this.candidates.brokenNoteLinks : native ? this.candidates.nativeLinks : this.candidates.brokenLinks;
			const page = this.pageFor(currentTab, candidates.length);
			const pageItems = candidates.slice(page * CLEANUP_PAGE_SIZE, (page + 1) * CLEANUP_PAGE_SIZE);
				this.addSelectionControls(toolbar, pageItems.length, candidates.length,
						() => pageItems.forEach((item) => { if (note) this.noteLinkSelections.add(brokenNoteLinkKey(item as unknown as BrokenNoteLink)); else if (native) this.nativeSelections.add(nativeImageLinkKey(item)); else this.linkSelections.add(brokenLinkKey(item)); }),
						() => candidates.forEach((item) => { if (note) this.noteLinkSelections.add(brokenNoteLinkKey(item as unknown as BrokenNoteLink)); else if (native) { if (convertNativeImageLink(item)) this.nativeSelections.add(nativeImageLinkKey(item)); } else this.linkSelections.add(brokenLinkKey(item)); }),
						() => pageItems.forEach((item) => { if (note) this.noteLinkSelections.delete(brokenNoteLinkKey(item as unknown as BrokenNoteLink)); else if (native) this.nativeSelections.delete(nativeImageLinkKey(item)); else this.linkSelections.delete(brokenLinkKey(item)); }),
				() => { if (note) this.noteLinkSelections.clear(); else if (native) this.nativeSelections.clear(); else this.linkSelections.clear(); },
				() => { this.syncPageCheckboxes(content, true); this.updateSelectionSummary(); },
				() => { this.syncPageCheckboxes(content, false); this.updateSelectionSummary(); });
			if (candidates.length === 0) {
				content.createEl('p', { text: note ? '没有发现失效笔记链接。' : native ? '没有发现原生图片链接。' : '没有发现失效图片链接。', cls: 'orphan-cleanup-empty' });
				return;
			}
				if (note) this.renderBrokenNoteLinkList(content, pageItems as unknown as BrokenNoteLink[]); else native ? this.renderNativeLinkList(content, pageItems) : this.renderBrokenLinkList(content, pageItems);
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
					? '没有发现未引用图片。'
					: this.activeTab === 'attachments'
						? '没有发现未引用附件。'
					: this.activeTab === 'empty-files'
						? '没有发现空文件。'
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
		header.createEl('th', { text: this.activeTab === 'images' ? '图片' : this.activeTab === 'empty-files' ? '文件' : this.activeTab === 'attachments' ? '附件' : '文件夹' });
		header.createEl('th', { text: this.activeTab === 'images' || this.activeTab === 'attachments' ? '大小' : this.activeTab === 'empty-files' ? '大小' : '说明' });
		header.createEl('th', { text: '操作' });
		const body = table.createEl('tbody');
		for (const group of this.groupedItems(pageItems)) {
			if (group.label) {
				const groupRow = body.createEl('tr', { cls: 'orphan-cleanup-group' });
				groupRow.createEl('td', { text: `${group.label}（${group.items.length}）`, attr: { colspan: this.activeTab === 'images' ? '5' : '4' } });
			}
			for (const item of group.items) this.renderItemRow(body, item);
		}
		this.renderPagination(toolbar, items.length, page, (next) => { this.pages.set(currentTab, next); this.renderContents(); });
	}

	private renderDuplicateGroups(container: HTMLElement, groups: DuplicateFileGroup[]) {
		for (const group of groups) {
			const section = container.createDiv({ cls: 'orphan-cleanup-duplicate-group' });
			section.createEl('h3', { text: `${group.files.length} 个文件 · ${formatBytes(group.size)}` });
			section.createDiv({ text: `SHA-256：${group.hash}`, cls: 'orphan-cleanup-detail' });
			const table = section.createEl('table', { cls: 'orphan-cleanup-table orphan-cleanup-duplicate-table' });
			const header = table.createEl('thead').createEl('tr');
			for (const text of ['文件', '所在笔记', '所在文件夹', '状态', '操作']) header.createEl('th', { text });
			const body = table.createEl('tbody');
			for (const file of group.files) {
				const row = body.createEl('tr');
				const fileCell = row.createEl('td', { cls: 'orphan-cleanup-path' });
				if (isImageFile(file.extension)) {
					const preview = fileCell.createEl('img', { attr: { alt: `${file.path} 预览`, loading: 'lazy' }, cls: 'orphan-cleanup-duplicate-preview' });
					const target = this.app.vault.getAbstractFileByPath(file.path);
					if (target instanceof TFile) preview.src = this.app.vault.getResourcePath(target);
					preview.title = '点击预览';
					preview.addEventListener('click', () => { if (target instanceof TFile) new ImagePreviewModal(this.app, [target], 0, async () => {}).open(); });
				}
				const link = fileCell.createEl('a', { text: file.path, cls: 'orphan-cleanup-link' });
				link.addEventListener('click', (event) => { event.preventDefault(); void this.app.workspace.openLinkText(file.path, '', 'tab'); });
				const notesCell = row.createEl('td', { cls: 'orphan-cleanup-detail' });
				if (file.referencingNotes.length) {
					for (const [index, note] of file.referencingNotes.entries()) {
						if (index) notesCell.appendText('、');
						const noteLink = notesCell.createEl('a', { text: note, cls: 'orphan-cleanup-link' });
						noteLink.addEventListener('click', (event) => { event.preventDefault(); void this.app.workspace.openLinkText(note, '', 'tab'); });
					}
				} else notesCell.setText('未发现引用');
				const folderCell = row.createEl('td', { cls: 'orphan-cleanup-detail' });
				const folderPath = parentFolder(file.path);
				if (!folderPath) folderCell.setText('根目录');
				else {
					const folderLink = folderCell.createEl('a', { text: folderPath, cls: 'orphan-cleanup-link' });
					folderLink.addEventListener('click', (event) => {
						event.preventDefault();
						const folder = this.app.vault.getAbstractFileByPath(folderPath);
						if (folder instanceof TFolder) openFolderInVault(this.app, folder);
					});
				}
				row.createEl('td', { text: `${file.extension.toUpperCase() || '无扩展名'} · ${file.referenced ? '已被引用' : '未发现引用'}`, cls: 'orphan-cleanup-detail' });
				const actions = row.createEl('td');
				const locate = actions.createEl('button', { cls: 'orphan-cleanup-icon-button' });
				setIcon(locate, 'locate-fixed'); locate.title = '在笔记中定位'; locate.setAttribute('aria-label', '在笔记中定位');
				locate.addEventListener('click', () => void this.locateDuplicateReference(file));
				if (isImageFile(file.extension)) {
					const clean = actions.createEl('button', { cls: 'orphan-cleanup-icon-button' });
					setIcon(clean, 'eraser'); clean.title = '清理图片链接'; clean.setAttribute('aria-label', '清理图片链接');
					clean.addEventListener('click', () => void this.cleanDuplicateLinks(file));
					const remove = actions.createEl('button', { cls: 'orphan-cleanup-icon-button' });
					setIcon(remove, 'trash-2'); remove.title = '删除图片'; remove.setAttribute('aria-label', '删除图片');
					remove.addEventListener('click', () => void this.deleteDuplicateFile(file));
				}
				const openFolder = actions.createEl('button', { cls: 'orphan-cleanup-icon-button' });
				setIcon(openFolder, 'folder-open'); openFolder.title = '打开所在文件夹'; openFolder.setAttribute('aria-label', '打开所在文件夹');
				openFolder.addEventListener('click', () => { const target = this.app.vault.getAbstractFileByPath(file.path); if (target) openInSystemFolder(this.app, target); });
			}
		}
	}

	private async locateDuplicateReference(file: DuplicateFileGroup['files'][number]) {
		const note = file.referencingNotes[0];
		if (!note) { new Notice('没有找到引用此文件的笔记。'); return; }
		await this.app.workspace.openLinkText(note, '', false, { state: { mode: 'source' } });
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file || view.file.path !== note) { new Notice(`已打开引用笔记：${note}`); return; }
		const cache = this.app.metadataCache.getFileCache(view.file);
		const reference = [...cache?.embeds ?? [], ...cache?.links ?? []].find((item) => {
			if (!item.original.startsWith('!')) return false;
			return this.app.metadataCache.getFirstLinkpathDest(item.link.split('#', 1)[0] ?? '', note)?.path === file.path;
		});
		if (!reference) { new Notice(`已打开引用笔记：${note}`); return; }
		const from = view.editor.offsetToPos(reference.position.start.offset);
		const to = view.editor.offsetToPos(reference.position.end.offset);
		view.editor.setSelection(from, to);
		view.editor.scrollIntoView({ from, to }, true);
		new Notice(`已在笔记中定位：${note}`);
	}

	private async cleanDuplicateLinks(file: DuplicateFileGroup['files'][number]) {
		const result = await removeImageReferencesForFile(this.app, file.path);
		new Notice(`已清理 ${result.removed} 条图片链接${result.failed.length ? `，失败 ${result.failed.length} 个文件` : ''}。`);
		if (result.removed) await this.scan(true);
	}

	private async deleteDuplicateFile(file: DuplicateFileGroup['files'][number]) {
		if (!await new CleanupConfirmationModal(this.app, 1, 0, 0, 0).waitForConfirmation()) return;
		const target = this.app.vault.getAbstractFileByPath(file.path);
		if (!(target instanceof TFile)) { new Notice('文件不存在，请重新扫描。'); return; }
		try {
			await this.app.fileManager.trashFile(target);
			this.candidates.duplicates = this.candidates.duplicates
				.map((group) => ({ ...group, files: group.files.filter((item) => item.path !== file.path) }))
				.filter((group) => group.files.length > 1);
			this.selections.delete(file.path);
			this.renderContents();
			new Notice(`已移入回收站：${file.path}`);
		} catch (error) { new Notice(`删除失败：${reasonFor(error)}`); }
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
		const report = () => buildCleanupReport({ generatedAt: new Date().toLocaleString('zh-CN'), images: this.candidates.images.map((item) => item.path), attachments: this.candidates.attachments.map((item) => item.path), emptyFiles: this.candidates.emptyFiles.map((item) => item.path), folders: this.candidates.folders.map((item) => item.path), brokenLinks: this.candidates.brokenLinks.map(({ sourcePath, original, linkPath }) => ({ sourcePath, original, linkPath })), nativeLinks: this.candidates.nativeLinks.map((item) => ({ sourcePath: item.sourcePath, original: item.original, status: convertNativeImageLink(item) ?? item.reason ?? '未解析目标' })), brokenNoteLinks: this.candidates.brokenNoteLinks.map(({ sourcePath, original, linkPath, syntax }) => ({ sourcePath, original, linkPath, syntax })), duplicates: this.candidates.duplicates, duplicateWarnings: this.candidates.duplicateWarnings, processed: this.processed });
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
			checkbox.setAttribute('aria-label', `选择 ${link.sourcePath} 中的原生图片链接`);
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

	private renderBrokenNoteLinkList(container: HTMLElement, links: BrokenNoteLink[]) {
		const table = container.createEl('table', { cls: 'orphan-cleanup-table' });
		const header = table.createEl('thead').createEl('tr');
		for (const text of ['选择', '源笔记', '失效链接', '未解析目标', '类型', '操作']) header.createEl('th', { text });
		const body = table.createEl('tbody');
		for (const item of links) {
			const row = body.createEl('tr');
			const checkbox = row.createEl('td').createEl('input', { type: 'checkbox' });
			checkbox.checked = this.noteLinkSelections.has(brokenNoteLinkKey(item));
			checkbox.setAttribute('aria-label', `选择 ${item.sourcePath} 中的失效笔记链接`);
			checkbox.addEventListener('change', () => { if (checkbox.checked) this.noteLinkSelections.add(brokenNoteLinkKey(item)); else this.noteLinkSelections.delete(brokenNoteLinkKey(item)); this.updateSelectionSummary(); });
			const source = row.createEl('td').createEl('a', { text: item.sourcePath, cls: 'orphan-cleanup-link' });
			source.addEventListener('click', (event) => { event.preventDefault(); void this.app.workspace.openLinkText(item.sourcePath, '', 'tab'); });
			row.createEl('td', { text: item.original, cls: 'orphan-cleanup-detail' });
			row.createEl('td', { text: item.linkPath, cls: 'orphan-cleanup-detail' });
			row.createEl('td', { text: item.syntax, cls: 'orphan-cleanup-detail' });
			const actions = row.createEl('td');
			actions.createEl('button', { text: '定位' }).addEventListener('click', () => void this.locateBrokenNoteLink(item));
			actions.createEl('button', { text: '忽略' }).addEventListener('click', () => { this.candidates.brokenNoteLinks = this.candidates.brokenNoteLinks.filter((candidate) => brokenNoteLinkKey(candidate) !== brokenNoteLinkKey(item)); this.renderContents(); });
		}
	}

	private async locateBrokenNoteLink(link: BrokenNoteLink) {
		await this.app.workspace.openLinkText(link.sourcePath, '', false, { state: { mode: 'source' } });
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const range = findBrokenNoteLinkOffset(view.editor.getValue(), link);
		if (!range) { new Notice('笔记内容已变化，请重新扫描。'); return; }
		const from = view.editor.offsetToPos(range.start); const to = view.editor.offsetToPos(range.end);
		view.editor.setSelection(from, to); view.editor.scrollIntoView({ from, to }, true);
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
		const openFolder = header.createEl('button', { cls: 'orphan-cleanup-open-folder' });
		openFolder.type = 'button';
		openFolder.title = '打开所在文件夹';
		openFolder.setAttribute('aria-label', '打开所在文件夹');
		setIcon(openFolder, 'folder-open');
		openFolder.addEventListener('click', () => openInSystemFolder(this.app, file));
		const preview = card.createEl('img', { attr: { alt: `${file.name} 预览`, loading: 'lazy' } });
		preview.src = this.app.vault.getResourcePath(file);
		preview.title = '点击预览';
		preview.addEventListener('click', () => new ImagePreviewModal(this.app, items, items.indexOf(file), (selectedFile) => this.trashPreviewImage(selectedFile)).open());
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
		try {
			const { files, skipped } = await this.revalidateCleanupSelection([file.path], []);
			if (skipped.length || files.length === 0) {
				this.removeImage(file);
				new Notice(`未移动：${file.name} 已被引用或不存在。`);
				return;
			}
			await this.app.fileManager.trashFile(files[0]!);
			this.removeImage(file);
			new Notice(`已移入回收站：${file.name}`);
		} catch (error) {
			new Notice(`删除失败：${reasonFor(error)}`);
		}
	}

	private async trashPreviewImage(file: TFile) {
		await this.trashSingleImage(file);
		this.renderContents();
	}

	private removeImage(file: TFile) {
		this.candidates.images = this.candidates.images.filter((item) => item.path !== file.path);
		this.candidates.folders = findRecursivelyEmptyFolders(this.app.vault.getRoot(), parseIgnoredFolders(this.settings.orphanIgnoredFolders)).sort((a, b) => b.path.length - a.path.length || byPath(a, b));
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
			['images', '未引用图片', this.candidates.images.length],
			['attachments', '未引用附件', this.candidates.attachments.length],
			['broken-links', '失效图片链接', this.candidates.brokenLinks.length],
			['empty-files', '空文件', this.candidates.emptyFiles.length],
			['folders', '空文件夹', this.candidates.folders.length],
			['native-links', '原生图片链接', this.candidates.nativeLinks.length],
			['broken-note-links', '失效笔记链接', this.candidates.brokenNoteLinks.length],
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

	private addGroupingControl(container: HTMLElement) {
		const label = container.createEl('label', { cls: 'orphan-cleanup-grouping' });
		label.createSpan({ text: '分组：' });
		const select = label.createEl('select');
		const grouping = this.activeTab === 'attachments' ? this.attachmentGrouping : this.imageGrouping;
		for (const [value, text] of [
			['none', '不分组'],
			['path', '按路径'],
			['extension', '按格式'],
		] as const) {
			const option = select.createEl('option', { text, value });
			option.selected = value === grouping;
		}
		select.addEventListener('change', () => {
			if (this.activeTab === 'attachments') this.attachmentGrouping = select.value as ImageGrouping;
			else this.imageGrouping = select.value as ImageGrouping;
			this.renderContents();
		});
	}

	private groupedItems(items: TAbstractFile[]) {
		const grouping = this.activeTab === 'attachments' ? this.attachmentGrouping : this.imageGrouping;
		if ((this.activeTab !== 'images' && this.activeTab !== 'attachments') || grouping === 'none') return [{ label: '', items }];
		const groups = new Map<string, TAbstractFile[]>();
		for (const item of items) {
			if (!(item instanceof TFile)) continue;
			const label = grouping === 'path' ? parentFolder(item.path) || '根目录' : `.${item.extension.toUpperCase()}`;
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
		checkbox.setAttribute('aria-label', `选择 ${item.path}`);
		checkbox.addEventListener('change', () => {
			if (checkbox.checked) this.selections.add(item.path);
			else this.selections.delete(item.path);
			this.updateSelectionSummary();
		});
		if (this.activeTab === 'images' && item instanceof TFile) this.addImagePreview(row, item);
		const pathCell = row.createEl('td', { cls: 'orphan-cleanup-path' });
		const link = pathCell.createEl('a', { text: item.path, cls: 'orphan-cleanup-link' });
		link.addEventListener('click', (event) => {
			event.preventDefault();
			void this.app.workspace.openLinkText(item.path, '', 'tab');
		});
		row.createEl('td', {
			text: item instanceof TFile ? (this.activeTab === 'attachments' ? `${item.extension.toUpperCase()} · ${formatBytes(item.stat.size)}` : formatBytes(item.stat.size)) : '仅包含空子文件夹或没有子项',
			cls: 'orphan-cleanup-detail',
		});
		const actions = row.createEl('td');
		const openFolder = actions.createEl('button', { cls: 'orphan-cleanup-open-folder' });
		openFolder.type = 'button';
		openFolder.title = '打开所在文件夹';
		openFolder.setAttribute('aria-label', '打开所在文件夹');
		setIcon(openFolder, 'folder-open');
		openFolder.addEventListener('click', () => openInSystemFolder(this.app, item));
	}

	private addImagePreview(row: HTMLElement, file: TFile) {
		const cell = row.createEl('td', { cls: 'orphan-cleanup-preview' });
		const preview = cell.createEl('img', { attr: { alt: `${file.name} 预览`, loading: 'lazy' } });
		preview.src = this.app.vault.getResourcePath(file);
		preview.title = '点击放大预览';
		preview.addEventListener('click', () => new ImagePreviewModal(this.app, [file], 0, (selectedFile) => this.trashPreviewImage(selectedFile)).open());
		preview.addEventListener('error', () => {
			preview.replaceWith(cell.createSpan({ text: '无法预览', cls: 'orphan-cleanup-preview-failed' }));
		});
	}

	private renderActions() {
		const actions = this.contentEl.createDiv({ cls: 'orphan-cleanup-actions' });
		const summary = actions.createSpan({ cls: 'orphan-cleanup-summary' });
		summary.setAttribute('aria-live', 'polite');
		this.updateSelectionSummary(summary);
		const isLinkTab = this.activeTab === 'broken-links' || this.activeTab === 'native-links' || this.activeTab === 'broken-note-links';
		const cleanup = actions.createEl('button', {
			text: this.activeTab === 'native-links' ? '转换选中链接' : this.activeTab === 'broken-note-links' ? '创建选中笔记' : isLinkTab ? '移除选中链接' : '移入回收站',
			cls: 'mod-cta',
		});
		cleanup.disabled = this.activeTab === 'broken-links' ? this.linkSelections.size === 0 : this.activeTab === 'native-links' ? this.nativeSelections.size === 0 : this.activeTab === 'broken-note-links' ? this.noteLinkSelections.size === 0 : this.selections.size === 0;
		cleanup.addEventListener('click', () => void (this.activeTab === 'native-links' ? this.confirmConvertLinks() : this.activeTab === 'broken-note-links' ? this.confirmCreateNotes() : isLinkTab ? this.confirmRemoveLinks() : this.confirmCleanup()));
		if (this.activeTab === 'broken-note-links') {
			const remove = actions.createEl('button', { text: '移除选中链接', cls: 'orphan-cleanup-remove-note-links' });
			remove.disabled = this.noteLinkSelections.size === 0;
			remove.addEventListener('click', () => void this.confirmRemoveNoteLinks());
		}
	}

	private updateSelectionSummary(summary?: HTMLElement) {
		const target = summary ?? this.contentEl.querySelector<HTMLElement>('.orphan-cleanup-summary');
		if (!target) return;
		const images = this.candidates.images.filter((item) => this.selections.has(item.path)).length;
		const attachments = this.candidates.attachments.filter((item) => this.selections.has(item.path)).length;
		const emptyFiles = this.candidates.emptyFiles.filter((item) => this.selections.has(item.path)).length;
		const folders = this.candidates.folders.filter((item) => this.selections.has(item.path)).length;
		const links = this.candidates.brokenLinks.filter((item) => this.linkSelections.has(brokenLinkKey(item))).length;
		const native = this.candidates.nativeLinks.filter((item) => this.nativeSelections.has(nativeImageLinkKey(item))).length;
		const noteLinks = this.candidates.brokenNoteLinks.filter((item) => this.noteLinkSelections.has(brokenNoteLinkKey(item))).length;
		target.setText(`已选：${images} 张图片，${attachments} 个附件，${emptyFiles} 个空文件，${links + native + noteLinks} 条链接，${folders} 个文件夹`);
		const action = this.contentEl.querySelector<HTMLButtonElement>('.orphan-cleanup-actions button.mod-cta');
		if (action) action.disabled = this.activeTab === 'broken-links' ? links === 0 : this.activeTab === 'native-links' ? native === 0 : this.activeTab === 'broken-note-links' ? noteLinks === 0 : images + attachments + emptyFiles + folders === 0;
		const removeNoteLinks = this.contentEl.querySelector<HTMLButtonElement>('.orphan-cleanup-remove-note-links');
		if (removeNoteLinks) removeNoteLinks.disabled = noteLinks === 0;
	}

	private itemsForActiveTab(): TAbstractFile[] {
		return this.activeTab === 'images' ? this.candidates.images : this.activeTab === 'attachments' ? this.candidates.attachments : this.activeTab === 'empty-files' ? this.candidates.emptyFiles : this.candidates.folders;
	}

	private async confirmCleanup() {
		const selectedImages = this.candidates.images.filter((item) => this.selections.has(item.path));
		const selectedAttachments = this.candidates.attachments.filter((item) => this.selections.has(item.path));
		const selectedEmptyFiles = this.candidates.emptyFiles.filter((item) => this.selections.has(item.path));
		const selectedFolders = this.candidates.folders.filter((item) => this.selections.has(item.path));
		if (selectedImages.length + selectedAttachments.length + selectedEmptyFiles.length + selectedFolders.length === 0) return;
		const confirmed = await new CleanupConfirmationModal(this.app, selectedImages.length, selectedAttachments.length, selectedEmptyFiles.length, selectedFolders.length).waitForConfirmation();
		if (!confirmed) return;
		let verified: { files: TFile[]; folders: TFolder[]; skipped: string[] };
		try {
			verified = await this.revalidateCleanupSelection(
				[selectedImages, selectedAttachments, selectedEmptyFiles].flat().map((item) => item.path),
				selectedFolders.map((item) => item.path),
			);
		} catch (error) {
			new Notice(`重新确认清理条件失败：${reasonFor(error)}`);
			return;
		}
		const result = await trashSelected(this.app, verified.files, verified.folders);
		result.skipped.unshift(...verified.skipped);
		this.processed = { success: result.deleted.length, skipped: result.skipped.length, failed: result.failed };
		const message = [`已移入回收站：${result.deleted.length}`, `跳过：${result.skipped.length}`, `失败：${result.failed.length}`];
		if (result.skipped.length) message.push(`跳过文件：${result.skipped.join('、')}`);
		if (result.failed.length) message.push(result.failed.map((item) => `${item.path}（${item.reason}）`).join('、'));
		new Notice(message.join('\n'));
		await this.scan(true);
	}

	private async revalidateCleanupSelection(filePaths: Iterable<string>, folderPaths: Iterable<string>) {
		const current = await findCleanupCandidates(this.app, this.settings.orphanImageExtensions, this.settings.orphanIgnoredFolders);
		const files = selectCurrentCleanupItems(filePaths, [...current.images, ...current.attachments, ...current.emptyFiles]);
		const folders = selectCurrentCleanupItems(folderPaths, current.folders);
		return { files: files.items, folders: folders.items, skipped: [...files.skipped, ...folders.skipped] };
	}

	private async confirmRemoveLinks() {
		if (this.activeTab === 'broken-note-links') return this.confirmRemoveNoteLinks();
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
		await this.scan(true);
	}

	private async confirmRemoveNoteLinks() {
		const selected = this.candidates.brokenNoteLinks.filter((item) => this.noteLinkSelections.has(brokenNoteLinkKey(item)));
		if (!selected.length) return;
		const sourceCount = new Set(selected.map((item) => item.sourcePath)).size;
		if (!await new RemoveBrokenLinksConfirmationModal(this.app, selected.length, sourceCount).waitForConfirmation()) return;
		const result = await removeSelectedBrokenNoteLinks(this.app, selected);
		this.processed = { success: result.removed, skipped: result.skipped, failed: result.failed };
		new Notice(`已移除链接：${result.removed}，跳过：${result.skipped}，失败：${result.failed.length}`);
		await this.scan(true);
	}

	private async confirmCreateNotes() {
		const selected = this.candidates.brokenNoteLinks.filter((item) => this.noteLinkSelections.has(brokenNoteLinkKey(item)));
		if (!selected.length || !await new CreateNotesConfirmationModal(this.app, selected.length).waitForConfirmation()) return;
		const result = await createMissingNotes(this.app, selected);
		this.processed = { success: result.created.length, skipped: result.skipped.length, failed: result.failed };
		new Notice(`已创建：${result.created.length}，跳过：${result.skipped.length}，失败：${result.failed.length}`);
		await this.scan(true);
	}

	private async confirmConvertLinks() {
		const selected = this.candidates.nativeLinks.filter((item) => this.nativeSelections.has(nativeImageLinkKey(item)));
		if (!selected.length) return;
		if (!await new ConvertNativeLinksConfirmationModal(this.app, selected.length).waitForConfirmation()) return;
		let converted = 0, skipped = 0, failed = 0;
		const failures: Array<{ path: string; reason: string }> = [];
		const currentLinks = selected.map((link) => revalidateNativeImageLink(this.app, link));
		for (const [path, links] of new Map([...currentLinks].reduce((map, link) => { const list = map.get(link.sourcePath) ?? []; list.push(link); map.set(link.sourcePath, list); return map; }, new Map<string, NativeImageLink[]>())) ) {
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
		this.titleEl.setText('Vault 体检与清理');
		this.panel = new OrphanCleanupPanel(this.app, this.contentEl, this.settings, this);
		this.panel.render();
	}

	onClose() {
		this.modalEl.removeClass('orphan-cleanup-dialog');
		this.panel?.dispose();
		this.panel = undefined;
		this.contentEl.empty();
	}
}

async function findCleanupCandidates(app: App, imageExtensions: string, ignoredFoldersValue = '', onProgress?: (progress: ScanProgress) => void): Promise<CleanupCandidates> {
	const extensions = parseExtensions(imageExtensions);
	const ignoredFolders = parseIgnoredFolders(ignoredFoldersValue);
	const visibleFiles = app.vault.getFiles().filter((file) => !hasHiddenPathSegment(file.path) && !isIgnoredPath(file.path, ignoredFolders));
	onProgress?.({ stage: 0, processed: visibleFiles.length, total: visibleFiles.length, currentFile: visibleFiles.at(-1)?.path });
	const attachmentFiles = visibleFiles.filter((file) => !['md', 'canvas'].includes(file.extension.toLowerCase()));
	const images = attachmentFiles.filter((file) => extensions.has(file.extension.toLowerCase()));
	const attachments = attachmentFiles.filter((file) => !extensions.has(file.extension.toLowerCase()));
	const referenced = new Set<string>();
	for (const [sourcePath, destinations] of Object.entries(app.metadataCache.resolvedLinks)) {
		if (!sourcePath.toLowerCase().endsWith('.md')) continue;
		for (const path of Object.keys(destinations)) referenced.add(path);
	}
	const canvases = app.vault.getFiles().filter((file) => file.extension.toLowerCase() === 'canvas');
	for (const [index, canvas] of canvases.entries()) {
		for (const path of await referencedByCanvas(app, canvas)) referenced.add(path);
		onProgress?.({ stage: 1, processed: index + 1, total: canvases.length || 1, currentFile: canvas.path });
	}
	onProgress?.({ stage: 2, processed: 0, total: app.vault.getMarkdownFiles().length });
	// Conservative textual pass: HTML image tags, frontmatter path values, and
	// code-block text do not appear in resolvedLinks. Any textual mention of the
	// file name or path counts as a reference so that such images are never
	// flagged as orphans.
	await markFilesReferencedByText(app, [...images, ...attachments], referenced, (processed, total, currentFile) => onProgress?.({ stage: 2, processed, total, currentFile }));
	const emptyFiles = (await findEmptyFiles(visibleFiles, extensions, app, (processed, total, currentFile) => onProgress?.({ stage: 3, processed, total, currentFile }))).filter((file) => !referenced.has(file.path));
	const folders = findRecursivelyEmptyFolders(app.vault.getRoot(), ignoredFolders).sort((a, b) => b.path.length - a.path.length || byPath(a, b));
	onProgress?.({ stage: 3, processed: visibleFiles.length, total: visibleFiles.length, currentFile: visibleFiles.at(-1)?.path });
	const brokenLinks = findBrokenImageLinks(app, imageExtensions);
	const nativeLinks = findNativeImageLinks(app, imageExtensions);
		const brokenNoteLinks = findBrokenNoteLinks(app, imageExtensions);
		onProgress?.({ stage: 5, processed: 0, total: 1 });
		const duplicateResult = await findDuplicateFiles(app, ignoredFoldersValue, (progress) => onProgress?.({ stage: 5, ...progress }));
	return {
		images: images.filter((file) => !referenced.has(file.path)).sort(byPath),
		attachments: attachments.filter((file) => !referenced.has(file.path)).sort(byPath),
		emptyFiles,
		folders,
		brokenLinks,
		nativeLinks,
		brokenNoteLinks,
		duplicates: duplicateResult.groups,
		duplicateWarnings: duplicateResult.warnings,
	};
}

async function findEmptyFiles(files: TFile[], imageExtensions: Set<string>, app: App, onProgress?: (processed: number, total: number, currentFile: string) => void): Promise<TFile[]> {
	const result: TFile[] = [];
	for (const [index, file] of files.entries()) {
		onProgress?.(index + 1, files.length, file.path);
		const extension = file.extension.toLowerCase();
		if (extension === 'canvas') continue;
		if (file.stat.size === 0 && !imageExtensions.has(extension) && !COMMON_IMAGE_EXTENSIONS.has(extension)) { result.push(file); continue; }
		if (file.extension.toLowerCase() !== 'md') continue;
		const content = await app.vault.cachedRead(file);
		if (isFrontmatterOnly(content)) result.push(file);
	}
	return result.sort(byPath);
}

async function markFilesReferencedByText(app: App, images: TFile[], referenced: Set<string>, onProgress?: (processed: number, total: number, currentFile: string) => void): Promise<void> {
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
	const markdownFiles = app.vault.getMarkdownFiles();
	for (const [index, file] of markdownFiles.entries()) {
		onProgress?.(index + 1, markdownFiles.length, file.path);
		const content = await app.vault.cachedRead(file);
		for (const token of pathLikeTokens(content)) {
			for (const candidate of pathTokenCandidates(token.replace(/^[./\\]+/, ''))) {
				for (const variant of [candidate, safeDecodePath(candidate)]) {
					const direct = byPath.get(variant.toLowerCase());
					if (direct) referenced.add(direct);
					for (const path of byBasename.get(lastPathSegment(variant).toLowerCase()) ?? []) referenced.add(path);
				}
			}
		}
		for (let index = exoticNames.length - 1; index >= 0; index--) {
			const key = exoticNames[index]!;
			if (!content.toLowerCase().includes(key)) continue;
			for (const path of byBasename.get(key) ?? []) referenced.add(path);
			exoticNames.splice(index, 1);
		}
		if (remaining.every((image) => referenced.has(image.path))) return;
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

function safeDecodePath(path: string) {
	try { return decodeURIComponent(path); } catch { return path; }
}

function formatScanDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

async function trashSelected(app: App, images: TFile[], folders: TFolder[]): Promise<CleanupResult> {
	const result: CleanupResult = { deleted: [], skipped: [], failed: [] };
	const moveToLocalTrash = app.fileManager.trashFile.bind(app.fileManager);
	for (const item of [...images, ...folders.sort((a, b) => b.path.length - a.path.length)]) {
		if (!app.vault.getAbstractFileByPath(item.path)) { result.skipped.push(item.path); continue; }
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

function openInSystemFolder(app: App, item: TAbstractFile) {
	if (!Platform.isDesktopApp || !(app.vault.adapter instanceof FileSystemAdapter)) {
		new Notice('仅桌面端的本地资料库支持打开所在文件夹。');
		return;
	}
	const electron = (window as Window & {
		require?: (module: string) => { shell?: { showItemInFolder(path: string): void; openPath?: (path: string) => Promise<string> } };
	}).require?.('electron');
	if (!electron?.shell) {
		new Notice('当前环境无法打开系统文件夹。');
		return;
	}
	const path = `${app.vault.adapter.getBasePath()}/${item.path}`;
	if (item instanceof TFolder && electron.shell.openPath) void electron.shell.openPath(path).then((error) => { if (error) new Notice('打开文件夹失败。'); }, () => new Notice('打开文件夹失败。'));
	else {
		try { electron.shell.showItemInFolder(path); } catch { new Notice('打开文件夹失败。'); }
	}
}

function openFolderInVault(app: App, folder: TFolder) {
	const explorer = app.workspace.getLeavesOfType('file-explorer')[0]?.view as { revealInFolder?: (file: TAbstractFile) => void } | undefined;
	if (explorer?.revealInFolder) explorer.revealInFolder(folder);
	else openInSystemFolder(app, folder);
}

function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageFile(extension: string) {
	return COMMON_IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

function reasonFor(error: unknown) {
	return error instanceof Error ? error.message : '未知错误';
}

class CleanupConfirmationModal extends Modal {
	private resolver?: (confirmed: boolean) => void;
	private settled = false;

	constructor(app: App, private readonly imageCount: number, private readonly attachmentCount: number, private readonly emptyFileCount: number, private readonly folderCount: number) {
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
		this.contentEl.createEl('p', { text: `即将移入 Obsidian 回收站：${this.imageCount} 张图片、${this.attachmentCount} 个附件、${this.emptyFileCount} 个空文件、${this.folderCount} 个文件夹。` });
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

class CreateNotesConfirmationModal extends Modal {
	private resolver?: (confirmed: boolean) => void;
	private settled = false;
	constructor(app: App, private readonly count: number) { super(app); }
	waitForConfirmation() { return new Promise<boolean>((resolve) => { this.resolver = resolve; this.open(); }); }
	onOpen() {
		this.titleEl.setText('确认创建笔记');
		this.contentEl.createEl('p', { text: `将创建 ${this.count} 个空白 Markdown 笔记，并自动创建缺失父目录。` });
		this.contentEl.createEl('p', { text: '已有文件、非法路径和创建失败的目标会跳过或报告。', cls: 'orphan-cleanup-warning' });
		const actions = this.contentEl.createDiv({ cls: 'orphan-cleanup-actions' });
		actions.createEl('button', { text: '确认创建', cls: 'mod-cta' }).addEventListener('click', () => this.finish(true));
		actions.createEl('button', { text: '取消' }).addEventListener('click', () => this.finish(false));
	}
	onClose() { this.contentEl.empty(); if (!this.settled) this.finish(false); }
	private finish(value: boolean) { if (this.settled) return; this.settled = true; this.resolver?.(value); this.close(); }
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
		private readonly onDelete: (file: TFile) => Promise<void>,
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
		const openFolder = actions.createEl('button', { cls: 'orphan-cleanup-open-folder' });
		openFolder.title = '打开所在文件夹';
		openFolder.setAttribute('aria-label', '打开所在文件夹');
		setIcon(openFolder, 'folder-open');
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
		if (file) openInSystemFolder(this.app, file);
	}

	private async trashCurrent(file: TFile) {
		await this.onDelete(file);
		this.close();
	}
}
