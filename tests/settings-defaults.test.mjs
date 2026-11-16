import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const stub = `
export class TAbstractFile {}
export class TFile {}
export class TFolder {}
export class App {}
export class FileSystemAdapter {}
export class Notice { constructor() {} }
export class Component { register() {} registerEvent() {} registerInterval() {} }
export class Modal extends Component {}
export class ItemView extends Component {}
export class PluginSettingTab extends Component {}
export class MarkdownView {}
export const setIcon = () => {};
export const normalizePath = p => p;
export const Platform = {};
`;

const bundle = await build({
	stdin: {
		contents: "export { DEFAULT_SETTINGS, RelatedOperationsSettingTab } from './src/settings.ts'; export { DEFAULT_IMAGE_CONVERSION, cloneImageConversionConfig, normalizeImageConversionConfig } from './src/cleanup/cleanup-types.ts';",
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'node',
	plugins: [{
		name: 'obsidian-stub',
		setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
			b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub }));
		},
	}],
});

const {
	DEFAULT_SETTINGS,
	RelatedOperationsSettingTab,
	DEFAULT_IMAGE_CONVERSION,
	cloneImageConversionConfig,
	normalizeImageConversionConfig,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function makeTab() {
	const saved = [];
	const plugin = {
		settings: { imageConversion: cloneImageConversionConfig(DEFAULT_IMAGE_CONVERSION) },
		async saveSettings() { saved.push(true); },
	};
	const tab = new RelatedOperationsSettingTab({}, plugin);
	return { tab, plugin, saved };
}

test('默认图片转换配置不可被实例修改', () => {
	assert.equal(Object.isFrozen(DEFAULT_IMAGE_CONVERSION), true);
	assert.equal(Object.isFrozen(DEFAULT_IMAGE_CONVERSION.sources), true);
	assert.throws(() => DEFAULT_IMAGE_CONVERSION.sources.push('webp'), TypeError);
});

test('默认设置复制图片转换模板及其源格式数组', () => {
	assert.notEqual(DEFAULT_SETTINGS.imageConversion, DEFAULT_IMAGE_CONVERSION);
	assert.notEqual(DEFAULT_SETTINGS.imageConversion.sources, DEFAULT_IMAGE_CONVERSION.sources);
	assert.deepEqual(DEFAULT_SETTINGS.imageConversion, DEFAULT_IMAGE_CONVERSION);
});

test('cloneImageConversionConfig 返回可独立修改的副本', () => {
	const copy = cloneImageConversionConfig(DEFAULT_IMAGE_CONVERSION);
	copy.sources.push('webp');
	copy.quality = 60;
	assert.deepEqual(DEFAULT_IMAGE_CONVERSION.sources, ['png']);
	assert.equal(DEFAULT_IMAGE_CONVERSION.quality, 85);
});

test('规范化缺省配置时返回独立数组', () => {
	const normalized = normalizeImageConversionConfig(undefined);
	normalized.sources.push('webp');
	assert.deepEqual(DEFAULT_IMAGE_CONVERSION.sources, ['png']);
});

test('设置页把图片转换控件的嵌套键路由进嵌套配置', async () => {
	const { tab, plugin, saved } = makeTab();

	assert.equal(tab.getControlValue('imageConversion.target'), 'jpg');
	assert.equal(tab.getControlValue('imageConversion.quality'), 85);
	assert.equal(tab.getControlValue('imageConversion.alpha'), 'flatten');

	await tab.setControlValue('imageConversion.target', 'webp');
	await tab.setControlValue('imageConversion.quality', 70);

	assert.equal(plugin.settings.imageConversion.target, 'webp');
	assert.equal(plugin.settings.imageConversion.quality, 70);
	assert.equal(saved.length, 2, '每次修改都应落盘一次');
});

test('图片转换设置组定义目标格式、质量与透明图处理三项', () => {
	const { tab } = makeTab();
	const groups = tab.getSettingDefinitions().filter((item) => item.type === 'group');
	const conversion = groups.find((item) => item.heading === '图片转换默认配置');
	assert.ok(conversion, '设置页应有图片转换默认配置组');

	const keys = conversion.items
		.filter((item) => item.control)
		.map((item) => item.control.key);
	assert.deepEqual(keys.sort(), ['imageConversion.alpha', 'imageConversion.quality', 'imageConversion.target']);
});

test('图片转换设置组用说明条目交代源格式在页面内设置', () => {
	const { tab } = makeTab();
	const groups = tab.getSettingDefinitions().filter((item) => item.type === 'group');
	const conversion = groups.find((item) => item.heading === '图片转换默认配置');
	const note = conversion.items.find((item) => !item.control && /源格式/.test(item.desc ?? ''));
	assert.ok(note, '应有说明源格式在页面内设置的条目');
	assert.ok(note.name, '说明条目应有标题');
});
