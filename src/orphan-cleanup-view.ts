import { ItemView, WorkspaceLeaf } from 'obsidian';
import { OrphanCleanupPanel } from './orphan-cleanup';
import { RelatedOperationsSettings } from './settings';

export const ORPHAN_CLEANUP_VIEW_TYPE = 'related-operations-orphan-cleanup-view';

export class OrphanCleanupView extends ItemView {
	private panel?: OrphanCleanupPanel;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly settings: RelatedOperationsSettings,
	) {
		super(leaf);
	}

	getViewType() {
		return ORPHAN_CLEANUP_VIEW_TYPE;
	}

	getDisplayText() {
		return '清理孤立资源';
	}

	getIcon() {
		return 'trash-2';
	}

	async onOpen() {
		this.panel = new OrphanCleanupPanel(this.app, this.contentEl, this.settings, {
			close: () => this.leaf.detach(),
		});
		this.panel.render();
	}

	async onClose() {
		this.panel = undefined;
		this.contentEl.empty();
	}
}
