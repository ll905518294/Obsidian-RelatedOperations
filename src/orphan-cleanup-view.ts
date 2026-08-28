import { ItemView, WorkspaceLeaf } from 'obsidian';
import { OrphanCleanupPanel } from './orphan-cleanup';

export const ORPHAN_CLEANUP_VIEW_TYPE = 'related-operations-orphan-cleanup-view';

export class OrphanCleanupView extends ItemView {
	private panel?: OrphanCleanupPanel;

	constructor(leaf: WorkspaceLeaf, private readonly imageExtensions: string) {
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
		this.panel = new OrphanCleanupPanel(this.app, this.contentEl, this.imageExtensions, {
			close: () => this.leaf.detach(),
		});
		this.panel.render();
	}

	async onClose() {
		this.panel = undefined;
		this.contentEl.empty();
	}
}
