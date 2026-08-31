import { App, Notice, PluginSettingTab, SettingDefinition, SettingDefinitionItem } from 'obsidian';
import type RelatedOperationsPlugin from './main';
import { LinkStatsPropertyNames, LinkStatsSettings } from './link-stats';
import { CleanupCandidates } from './orphan-cleanup';

export interface RelatedOperationsSettings extends LinkStatsSettings {
	groupingMode: 'none' | 'source' | 'path';
	hideCompliant: boolean;
	orphanImageExtensions: string;
	orphanIgnoredFolders: string;
	orphanCleanupCache?: OrphanCleanupCache;
}

export interface OrphanCleanupCache {
	version: number;
	scannedAt: string;
	candidates: CleanupCandidates;
	settingsSnapshot: {
		orphanImageExtensions: string;
		orphanIgnoredFolders: string;
	};
}

export const DEFAULT_SETTINGS: RelatedOperationsSettings = {
	groupingMode: 'source',
	hideCompliant: true,
	orphanImageExtensions: 'png, jpg, jpeg, gif, webp, svg, bmp, avif, ico',
	orphanIgnoredFolders: '',
	enabled: false,
	autoUpdate: true,
	incomingProperty: 'related-operations-in-links',
	outgoingProperty: 'related-operations-out-links',
	bidirectionalProperty: 'related-operations-bidirectional-links',
};


export class RelatedOperationsSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: RelatedOperationsPlugin) {
		super(app, plugin);
	}

	// Shared by every apply path so validation and messages cannot drift.
	private async applyPropertyNames(draft: LinkStatsPropertyNames): Promise<boolean> {
		const names = Object.values(draft);
		if (names.some((name) => !name || /[\r\n]/.test(name)) || new Set(names).size !== names.length) {
			new Notice('属性名不能为空、不能换行，且三个属性名不能重复。');
			return false;
		}
		const result = await this.plugin.applyLinkStatsPropertyNames(draft);
		if (result.conflicts.length) {
			const sample = result.conflicts.slice(0, 3).map((item) => `${item.path}（${item.property}）`).join('、');
			new Notice(`未应用属性名：目标属性已存在于 ${result.conflicts.length} 篇笔记。${sample}`);
			return false;
		}
		new Notice(`属性名已应用，迁移 ${result.migrated} 篇笔记，更新 ${result.updated} 篇笔记。`);
		return true;
	}

	// Obsidian renders, search-indexes, persists, and validates declarative
	// settings from these definitions. Simple values bind via control.key
	// (auto-persisted); settings with side effects use render callbacks.
	getSettingDefinitions(): SettingDefinitionItem[] {
		const draft: LinkStatsPropertyNames = {
			incomingProperty: this.plugin.settings.incomingProperty,
			outgoingProperty: this.plugin.settings.outgoingProperty,
			bidirectionalProperty: this.plugin.settings.bidirectionalProperty,
		};
		return [
			{
				type: 'group',
				heading: '关联笔记整理默认行为',
				items: [
					{
						name: '默认分组方式',
						desc: '打开关联笔记整理时选择列表的分组方式。',
						control: {
							type: 'dropdown',
							key: 'groupingMode',
							options: { none: '不分组', source: '按源笔记分组', path: '按当前路径分组' },
						},
					},
					{
						name: '默认隐藏已在目标文件夹的笔记',
						desc: '已经位于最终目标文件夹的关联笔记默认不显示。',
						control: { type: 'toggle', key: 'hideCompliant' },
					},
				],
			},
			{
				type: 'group',
				heading: '关联数量属性',
				items: [
					{
						name: '写入关联数量到属性',
						desc: '开启后在 Markdown frontmatter 中维护关联数量。默认关闭。',
						render: (setting) => {
							setting.addToggle((toggle) => toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
								this.plugin.settings.enabled = value;
								await this.plugin.saveSettings();
								this.plugin.refreshLinkStatsUpdater();
							}));
						},
					},
					{
						name: '自动更新关联数量',
						desc: '笔记变化后自动更新关联数量。',
						render: (setting) => {
							setting.addToggle((toggle) => toggle.setValue(this.plugin.settings.autoUpdate).onChange(async (value) => {
								this.plugin.settings.autoUpdate = value;
								await this.plugin.saveSettings();
								if (!value) this.plugin.cancelPendingLinkStatsUpdate();
								if (value && this.plugin.settings.enabled) this.plugin.refreshLinkStatsUpdater();
							}));
						},
					},
					...this.linkStatsPropertyDefinitions(draft),
				],
			},
			{
				type: 'group',
				heading: '资源体检与清理',
				items: [
					{
						name: '可清理图片格式',
						desc: '用逗号分隔扩展名，例如 PNG, JPG, webp。扫描时不区分大小写，可省略前导点。',
						control: {
							type: 'text',
							key: 'orphanImageExtensions',
							placeholder: 'PNG, JPG, webp',
						},
					},
					{
						name: '忽略目录',
						desc: '用逗号、空格或换行分隔目录；目录及其子目录不会列入未引用资源和空文件夹扫描。',
						control: { type: 'text', key: 'orphanIgnoredFolders', placeholder: 'attachments, archive' },
					},
				],
			},
		];
	}

	private linkStatsPropertyDefinitions(draft: LinkStatsPropertyNames): SettingDefinition[] {
		const rows: SettingDefinition[] = [];
		for (const [name, key] of [
			['入链属性名', 'incomingProperty'],
			['出链属性名', 'outgoingProperty'],
			['双向链接属性名', 'bidirectionalProperty'],
		] as const) {
			rows.push({
				name,
				render: (setting) => {
					setting.addText((text) => text.setValue(draft[key]).onChange((value) => { draft[key] = value.trim(); }));
				},
			});
		}
		rows.push({
			name: '应用属性名',
			desc: '输入过程只保存草稿；点击应用后才会迁移旧属性并更新统计。',
			render: (setting) => {
				const refresh = () => {
					this.update();
				};
				setting
					.addButton((button) => button.setButtonText('应用').setCta().onClick(async () => {
						if (await this.applyPropertyNames(draft)) refresh();
					}))
					.addButton((button) => button.setButtonText('恢复当前属性名').onClick(refresh));
			},
		});
		return rows;
	}

}
