import { App, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import type RelatedOperationsPlugin from './main';
import { CleanupCandidates } from './orphan-cleanup';

export interface RelatedOperationsSettings {
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
};


export class RelatedOperationsSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: RelatedOperationsPlugin) {
		super(app, plugin);
	}

	// Obsidian renders, search-indexes, persists, and validates declarative
	// settings from these definitions. Simple values bind via control.key
	// (auto-persisted); settings with side effects use render callbacks.
	getSettingDefinitions(): SettingDefinitionItem[] {
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
				heading: '资源体检与清理',
				items: [
					{
						name: '清理前请确认',
						desc: '未引用文件与空文件夹会移入 Obsidian 回收站（可在回收站恢复）；移除或转换链接会直接改写 Markdown，不进入回收站。',
					},
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

}
