import { App, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import type RelatedOperationsPlugin from './main';
import type { OrphanCleanupCache } from './cleanup/cleanup-cache';
import {
	cloneImageConversionConfig,
	DEFAULT_IMAGE_CONVERSION,
	normalizeImageConversionConfig,
	type ImageConversionConfig,
} from './cleanup/cleanup-types';

export type { OrphanCleanupCache } from './cleanup/cleanup-cache';

export interface RelatedOperationsSettings {
	groupingMode: 'none' | 'source' | 'path';
	hideCompliant: boolean;
	orphanImageExtensions: string;
	orphanIgnoredFolders: string;
	lastSeenVersion: string;
	onboardingSeen: boolean;
	orphanCleanupCache?: OrphanCleanupCache;
	imageConversion?: ImageConversionConfig;
}

type ImageConversionField = keyof ImageConversionConfig;

const IMAGE_CONVERSION_MIN_QUALITY = 50;
const IMAGE_CONVERSION_MAX_QUALITY = 95;

function isImageConversionField(value: string): value is ImageConversionField {
	return value === 'sources' || value === 'target' || value === 'quality' || value === 'alpha';
}

export const DEFAULT_SETTINGS: RelatedOperationsSettings = {
	groupingMode: 'source',
	hideCompliant: true,
	orphanImageExtensions: 'png, jpg, jpeg, gif, webp, svg, bmp, avif, ico',
	orphanIgnoredFolders: '',
	lastSeenVersion: '',
	onboardingSeen: false,
	imageConversion: cloneImageConversionConfig(DEFAULT_IMAGE_CONVERSION),
};


export class RelatedOperationsSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: RelatedOperationsPlugin) {
		super(app, plugin);
	}

	// Obsidian renders, search-indexes, persists, and validates declarative
	// settings from these definitions. Simple values bind via control.key
	// (auto-persisted); settings with side effects use render callbacks.
	// 图片转换配置是嵌套对象，说明式控件的 key 无法直接映射到顶层属性，
	// 因此覆盖 getControlValue/setControlValue，把 `imageConversion.xxx` 形式
	// 的 key 路由进嵌套对象，控件本身仍走声明式语义（标签、描述、自动持久化）。
	getControlValue(key: string): unknown {
		if (key.startsWith('imageConversion.')) {
			const field = key.slice('imageConversion.'.length);
			if (!isImageConversionField(field)) return undefined;
			const conversion = this.plugin.settings.imageConversion
				?? cloneImageConversionConfig(DEFAULT_IMAGE_CONVERSION);
			return conversion[field];
		}
		return super.getControlValue(key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key.startsWith('imageConversion.')) {
			const field = key.slice('imageConversion.'.length);
			if (!isImageConversionField(field)) return;
			const current: Record<string, unknown> = {
				...(this.plugin.settings.imageConversion ?? cloneImageConversionConfig(DEFAULT_IMAGE_CONVERSION)),
			};
			current[field] = value;
			this.plugin.settings.imageConversion = cloneImageConversionConfig(
				normalizeImageConversionConfig(current),
			);
			await this.plugin.saveSettings();
			return;
		}
		await super.setControlValue(key, value);
	}

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
			{
				type: 'group',
				heading: '使用引导',
				items: [
					{
						name: '首次显示使用引导',
						// One stored flag: `onboardingSeen`. The toggle is inverted so
						// "on" means "show the wizard on first install".
						desc: '开启后，首次安装并加载插件时会自动弹出一次使用引导；关闭后不再自动弹出，仍可通过命令「打开使用引导」重看。',
						render: (setting) => {
							setting.addToggle((toggle) => toggle
								.setValue(!this.plugin.settings.onboardingSeen)
								.onChange(async (value) => {
									this.plugin.settings.onboardingSeen = !value;
									await this.plugin.saveSettings();
								}));
						},
					},
				],
			},
			{
				type: 'group',
				heading: '图片转换默认配置',
				items: [
					{
						name: '这些是默认值',
						desc: '源格式与临时调整在体检面板的「图片转换」页内设置；这里保存的是每次转换的默认目标格式、质量与透明图处理方式。',
					},
					{
						name: '目标格式',
						desc: '图片转换页的默认输出格式；进入页面后仍可在页面内临时调整。',
						control: {
							type: 'dropdown',
							key: 'imageConversion.target',
							options: { jpg: 'JPG', webp: 'WebP', png: 'PNG' },
						},
					},
					{
						name: '默认质量',
						desc: `转换质量，${IMAGE_CONVERSION_MIN_QUALITY}–${IMAGE_CONVERSION_MAX_QUALITY}；越高体积越大、画质越好。目标为 PNG 时质量不生效。`,
						control: {
							type: 'slider',
							key: 'imageConversion.quality',
							min: IMAGE_CONVERSION_MIN_QUALITY,
							max: IMAGE_CONVERSION_MAX_QUALITY,
							step: 1,
						},
					},
					{
						name: '透明图处理',
						desc: '含透明通道的图片默认处理方式：白底铺底后转换，或直接跳过。',
						control: {
							type: 'dropdown',
							key: 'imageConversion.alpha',
							options: { flatten: '白底', skip: '跳过' },
						},
					},
				],
			},
		];
	}

}
