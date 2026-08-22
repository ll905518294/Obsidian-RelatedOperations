import { App, PluginSettingTab, Setting } from 'obsidian';
import type RelatedOperationsPlugin from './main';

export interface RelatedOperationsSettings {
	groupBySource: boolean;
	groupByPath: boolean;
	hideCompliant: boolean;
}

export const DEFAULT_SETTINGS: RelatedOperationsSettings = {
	groupBySource: true,
	groupByPath: false,
	hideCompliant: true,
};

export class RelatedOperationsSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: RelatedOperationsPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName('关联笔记移动').setHeading();

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
	}
}
