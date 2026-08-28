import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type RelatedOperationsPlugin from './main';
import { LinkStatsPropertyNames, LinkStatsSettings } from './link-stats';

export interface RelatedOperationsSettings extends LinkStatsSettings {
	groupBySource: boolean;
	groupByPath: boolean;
	hideCompliant: boolean;
	orphanImageExtensions: string;
}

export const DEFAULT_SETTINGS: RelatedOperationsSettings = {
	groupBySource: true,
	groupByPath: false,
	hideCompliant: true,
	orphanImageExtensions: 'png, jpg, jpeg, gif, webp, svg, bmp, avif, ico',
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

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const draft: LinkStatsPropertyNames = {
			incomingProperty: this.plugin.settings.incomingProperty,
			outgoingProperty: this.plugin.settings.outgoingProperty,
			bidirectionalProperty: this.plugin.settings.bidirectionalProperty,
		};
		new Setting(containerEl).setName('关联笔记移动').setHeading();
		new Setting(containerEl).setName('移动面板默认行为').setHeading();

		new Setting(containerEl)
			.setName('默认按源笔记分组')
			.setDesc('打开移动面板时，按源笔记显示关联条目。')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.groupBySource)
				.onChange(async (value) => {
					this.plugin.settings.groupBySource = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('默认按当前路径分组')
			.setDesc('仅在未启用按源笔记分组时生效。')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.groupByPath)
				.onChange(async (value) => {
					this.plugin.settings.groupByPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('默认隐藏符合目标的条目')
			.setDesc('已经位于最终目标文件夹的关联笔记默认不显示。')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.hideCompliant)
				.onChange(async (value) => {
					this.plugin.settings.hideCompliant = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName('关联数量属性').setHeading();

		new Setting(containerEl).setName('写入关联数量到属性').setDesc('开启后在 Markdown frontmatter 中维护关联数量。默认关闭。')
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
				this.plugin.settings.enabled = value;
				await this.plugin.saveSettings();
				this.plugin.refreshLinkStatsUpdater();
			}));

		new Setting(containerEl).setName('自动更新关联数量').setDesc('笔记变化后自动更新关联数量。')
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.autoUpdate).onChange(async (value) => {
				this.plugin.settings.autoUpdate = value;
				await this.plugin.saveSettings();
				this.plugin.refreshLinkStatsUpdater();
			}));

		for (const [name, key] of [
			['入链属性名', 'incomingProperty'],
			['出链属性名', 'outgoingProperty'],
			['双向链接属性名', 'bidirectionalProperty'],
		] as const) {
			new Setting(containerEl).setName(name)
				.addText((text) => text.setValue(draft[key]).onChange((value) => { draft[key] = value.trim(); }));
		}

		new Setting(containerEl)
			.setName('应用属性名')
			.setDesc('输入过程只保存草稿；点击应用后才会迁移旧属性并更新统计。')
			.addButton((button) => button.setButtonText('应用').setCta().onClick(async () => {
				const names = Object.values(draft);
				if (names.some((name) => !name || /[\r\n]/.test(name)) || new Set(names).size !== names.length) {
					new Notice('属性名不能为空、不能换行，且三个属性名不能重复。');
					return;
				}
				const result = await this.plugin.applyLinkStatsPropertyNames(draft);
				new Notice(`属性名已应用，迁移 ${result.migrated} 篇笔记，更新 ${result.updated} 篇笔记。`);
				this.display();
			}))
			.addButton((button) => button.setButtonText('恢复当前属性名').onClick(() => this.display()));

		new Setting(containerEl).setName('孤立资源清理').setHeading();
		new Setting(containerEl)
			.setName('可清理图片格式')
			.setDesc('用逗号分隔扩展名，例如 PNG, JPG, webp。扫描时不区分大小写，可省略前导点。')
			.addText((text) => text
				.setPlaceholder('PNG, JPG, webp')
				.setValue(this.plugin.settings.orphanImageExtensions)
				.onChange(async (value) => {
					this.plugin.settings.orphanImageExtensions = value;
					await this.plugin.saveSettings();
				}));

	}
}
