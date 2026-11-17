import test from 'node:test';
import assert from 'node:assert/strict';
import {
	IMAGE_CONVERSION_DEFAULT_QUALITY,
	IMAGE_CONVERSION_MAX_QUALITY,
	IMAGE_CONVERSION_MIN_QUALITY,
	normalizeImageConversionConfig,
} from '../src/cleanup/cleanup-types.ts';

const defaults = {
	sources: ['png'],
	target: 'jpg',
	quality: 85,
	alpha: 'flatten',
};

test('quality 夹紧到 1–100，默认值 85', () => {
	assert.equal(IMAGE_CONVERSION_MIN_QUALITY, 1);
	assert.equal(IMAGE_CONVERSION_MAX_QUALITY, 100);
	assert.equal(IMAGE_CONVERSION_DEFAULT_QUALITY, 85);
	assert.equal(normalizeImageConversionConfig({ quality: -5 }).quality, 1);
	assert.equal(normalizeImageConversionConfig({ quality: 0 }).quality, 1);
	assert.equal(normalizeImageConversionConfig({ quality: 1 }).quality, 1);
	assert.equal(normalizeImageConversionConfig({ quality: 50 }).quality, 50);
	assert.equal(normalizeImageConversionConfig({ quality: 100 }).quality, 100);
	assert.equal(normalizeImageConversionConfig({ quality: 101 }).quality, 100);
	assert.equal(normalizeImageConversionConfig({ quality: 1e9 }).quality, 100);
});

test('非法 quality 回退默认值，小数按四舍五入后夹紧', () => {
	for (const quality of [undefined, null, NaN, Infinity, -Infinity, '90', {}, []]) {
		assert.equal(normalizeImageConversionConfig({ quality }).quality, defaults.quality);
	}
	assert.equal(normalizeImageConversionConfig({ quality: 0.4 }).quality, 1);
	assert.equal(normalizeImageConversionConfig({ quality: 50.4 }).quality, 50);
	assert.equal(normalizeImageConversionConfig({ quality: 94.6 }).quality, 95);
	assert.equal(normalizeImageConversionConfig({ quality: 99.6 }).quality, 100);
	assert.equal(normalizeImageConversionConfig({ quality: 100.6 }).quality, 100);
});

test('非法 target 与 alpha 回退默认枚举', () => {
	assert.equal(normalizeImageConversionConfig({ target: 'gif' }).target, defaults.target);
	assert.equal(normalizeImageConversionConfig({ target: null }).target, defaults.target);
	assert.equal(normalizeImageConversionConfig({ alpha: 'keep' }).alpha, defaults.alpha);
	assert.equal(normalizeImageConversionConfig({ alpha: null }).alpha, defaults.alpha);
	assert.equal(normalizeImageConversionConfig({ target: 'webp', alpha: 'skip' }).target, 'webp');
	assert.equal(normalizeImageConversionConfig({ target: 'png', alpha: 'skip' }).alpha, 'skip');
});

test('畸形 sources 被过滤、归一化、去重并限制在可转换格式内', () => {
	assert.deepEqual(
		normalizeImageConversionConfig({ sources: ['PNG', '.JPEG', 'gif', 'png', '', 42] }).sources,
		['png', 'jpg'],
	);
	assert.deepEqual(normalizeImageConversionConfig({ sources: [] }).sources, []);
	assert.deepEqual(normalizeImageConversionConfig({ sources: 'png' }).sources, defaults.sources);
	assert.deepEqual(normalizeImageConversionConfig({ sources: ['exe', 'tar.gz'] }).sources, []);
});

test('缺失、空对象与非对象输入保持完整默认配置', () => {
	for (const raw of [undefined, null, {}, [], 'config']) {
		assert.deepEqual(normalizeImageConversionConfig(raw), defaults);
	}
});

test('自定义 defaults 同时用于缺省字段与非法值回退', () => {
	const custom = { sources: ['webp'], target: 'png', quality: 70, alpha: 'skip' };
	assert.deepEqual(normalizeImageConversionConfig({ quality: 0 }, custom), {
		sources: ['webp'],
		target: 'png',
		quality: 1,
		alpha: 'skip',
	});
	assert.deepEqual(normalizeImageConversionConfig(undefined, custom), custom);
});
