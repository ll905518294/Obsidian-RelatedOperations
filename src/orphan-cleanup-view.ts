import { ItemView, WorkspaceLeaf } from 'obsidian';
import { OrphanCleanupPanel, OrphanCleanupOptions } from './orphan-cleanup';
import { RelatedOperationsSettings, OrphanCleanupCache } from './settings';

export const ORPHAN_CLEANUP_VIEW_TYPE = 'related-operations-orphan-cleanup-view';

export class OrphanCleanupView extends ItemView {
	private panel?: OrphanCleanupPanel;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly settings: RelatedOperationsSettings,
		private readonly saveData: () => Promise<void>,
	) {
		super(leaf);
	}

	getViewType() {
		return ORPHAN_CLEANUP_VIEW_TYPE;
	}

	getDisplayText() {
		return 'Vault 体检与清理';
	}

	getIcon() {
		return 'plus-square';
	}

	async onOpen() {
		this.contentEl.addClass('orphan-cleanup-view-host');
		this.contentEl.setAttribute('role', 'region');
		this.contentEl.setAttribute('aria-label', 'Vault 体检与清理');
		const options: OrphanCleanupOptions = {
			cachedCandidates: this.settings.orphanCleanupCache?.candidates,
			cachedAt: this.settings.orphanCleanupCache?.scannedAt,
			cachedSettings: this.settings.orphanCleanupCache?.settingsSnapshot,
			saveCache: async (cache: OrphanCleanupCache) => {
				this.settings.orphanCleanupCache = cache;
				await this.saveData();
			},
			saveSettings: async () => {
				await this.saveData();
			},
		};
		this.panel = new OrphanCleanupPanel(this.app, this.contentEl, this.settings, {
			close: () => this.leaf.detach(),
		}, options);
		this.panel.render();
	}

	async onClose() {
		this.panel?.dispose();
		this.panel = undefined;
		this.contentEl.empty();
	}
}
