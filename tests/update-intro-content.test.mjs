import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UPDATE_INTROS, currentUpdateIntro, shouldShowIntro } from '../src/update-intro-content.ts';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('首次安装或版本变化时显示，同版本不重复显示', () => {
	assert.equal(shouldShowIntro('1.4.5', ''), true, 'lastSeenVersion 为空时应显示');
	assert.equal(shouldShowIntro('1.4.5', undefined), true);
	assert.equal(shouldShowIntro('1.4.5', '1.4.5'), false, '同版本不得重复弹出');
	assert.equal(shouldShowIntro('1.4.5', '1.4.4'), true, '升级到新版本应显示');
});

test('忽略空白与前导 v，避免同一版本被误判为升级', () => {
	assert.equal(shouldShowIntro(' 1.4.5 ', 'v1.4.5'), false);
	assert.equal(shouldShowIntro('v1.4.5', '1.4.5'), false);
	assert.equal(shouldShowIntro('1.4.5', ' V1.4.5 '), false);
});

test('缺少已安装版本时不显示', () => {
	assert.equal(shouldShowIntro('', '1.4.4'), false);
	assert.equal(shouldShowIntro('   ', '1.4.4'), false);
});

test('按版本查询内置说明，兼容前导 v', () => {
	const intro = currentUpdateIntro('1.4.5');
	assert.ok(intro);
	assert.equal(intro.version, '1.4.5');
	assert.equal(currentUpdateIntro('v1.4.5'), intro);
	assert.equal(currentUpdateIntro('9.9.9'), undefined);
	assert.equal(currentUpdateIntro(''), undefined);
});

test('1.6.0 内置说明存在且覆盖本次发布内容', () => {
	const intro = currentUpdateIntro('1.6.0');
	assert.ok(intro, '1.6.0 必须有更新说明条目');
	assert.equal(intro.theme, '首次使用引导');
	const text = intro.sections.map((section) => section.title + section.items.join('\n')).join('\n');
	assert.match(text, /使用引导/);
	assert.match(text, /它能做什么|首次显示使用引导|仅桌面端/);
});

test('1.6.1 内置说明存在且覆盖老用户引导修复', () => {
	const intro = currentUpdateIntro('1.6.1');
	assert.ok(intro, '1.6.1 必须有更新说明条目');
	assert.equal(intro.theme, '所有用户都能看到使用引导');
	const text = intro.sections.map((section) => section.title + section.items.join('\n')).join('\n');
	assert.match(text, /未看过使用引导.*老用户/);
	assert.match(text, /打开使用引导/);
});

test('1.6.2 内置说明存在且覆盖软件名与版本展示', () => {
	const intro = currentUpdateIntro('1.6.2');
	assert.ok(intro, '1.6.2 必须有更新说明条目');
	assert.equal(intro.theme, '弹窗标注软件名与版本');
	const text = intro.sections.map((section) => section.title + section.items.join('\n')).join('\n');
	assert.match(text, /Vault Doctor/);
	assert.match(text, /版本号/);
});

test('1.6.3 内置说明存在且覆盖使用引导截图', () => {
	const intro = currentUpdateIntro('1.6.3');
	assert.ok(intro, '1.6.3 必须有更新说明条目');
	assert.equal(intro.theme, '使用引导加入界面截图');
	const text = intro.sections.map((section) => section.title + section.items.join('\n')).join('\n');
	assert.match(text, /扫描结果/);
	assert.match(text, /重复文件/);
	assert.match(text, /开始扫描/);
});

test('1.7.0 内置说明存在且覆盖图片转换', () => {
	const intro = currentUpdateIntro('1.7.0');
	assert.ok(intro, '1.7.0 必须有更新说明条目');
	assert.equal(intro.theme, '图片格式转换');
	const text = intro.sections.map((section) => section.title + section.items.join('\n')).join('\n');
	assert.match(text, /图片转换/);
	assert.match(text, /PNG/);
	assert.match(text, /预计节省/);
	assert.match(text, /Canvas/);
});

test('1.9.0 内置说明存在且覆盖首页入口与转换提速', () => {
	const intro = currentUpdateIntro('1.9.0');
	assert.ok(intro, '1.9.0 必须有更新说明条目');
	assert.equal(intro.theme, '首页入口与转换提速');
	assert.notEqual(UPDATE_INTROS[0].version, '1.9.0', '1.9.0 不应再排在最前');
	const text = [intro.summary, ...intro.sections.map((section) => section.title + section.items.join('\n'))].join('\n');
	assert.match(text, /图片转换/);
	assert.match(text, /按需/);
	assert.match(text, /4 路/);
	assert.match(text, /正在转换/);
	assert.match(text, /默认配置/);
	assert.match(text, /HTML 实体/);
	assert.match(text, /撤销记录/);
});

test('1.9.1 内置说明存在且覆盖样式兼容修正', () => {
	const intro = currentUpdateIntro('1.9.1');
	assert.ok(intro, '1.9.1 必须有更新说明条目');
	assert.equal(intro.theme, '样式兼容性修正');
	const text = [intro.summary, ...intro.sections.map((section) => section.title + section.items.join('\n'))].join('\n');
	assert.match(text, /样式/);
	assert.match(text, /主题|WebView/);
	assert.match(text, /功能没有变化|没有新增或改动功能/);
});

test('1.9.2 内置说明存在且覆盖社区审核后的兼容性清理', () => {
	const intro = currentUpdateIntro('1.9.2');
	assert.ok(intro, '1.9.2 必须有更新说明条目');
	assert.equal(intro.theme, '社区上架后的兼容性打磨');
	const text = [intro.summary, ...intro.sections.map((section) => section.title + section.items.join('\n'))].join('\n');
	assert.match(text, /社区市场/);
	assert.match(text, /兼容/);
	assert.match(text, /没有新增或改动功能/);
});

test('1.9.3 内置说明存在且覆盖补齐说明', () => {
	const intro = currentUpdateIntro('1.9.3');
	assert.ok(intro, '1.9.3 必须有更新说明条目');
	assert.equal(intro.theme, '补齐更新说明');
	assert.notEqual(UPDATE_INTROS[0].version, '1.9.3', '1.9.3 不应再排在最前');
	const text = [intro.summary, ...intro.sections.map((section) => section.title + section.items.join('\n'))].join('\n');
	assert.match(text, /1\.9\.1/);
	assert.match(text, /1\.9\.2/);
	assert.match(text, /功能没有变化/);
});

test('1.9.4 内置说明存在、位于最前，且覆盖图片转换界面与性能优化', () => {
	const intro = currentUpdateIntro('1.9.4');
	assert.ok(intro, '1.9.4 必须有更新说明条目');
	assert.equal(intro.theme, '图片转换更清爽更快');
	assert.equal(UPDATE_INTROS[0].version, '1.9.4', '最新版本必须排在最前');
	const text = [intro.summary, ...intro.sections.map((section) => section.title + section.items.join('\n'))].join('\n');
	assert.match(text, /源格式/);
	assert.match(text, /200/);
	assert.match(text, /显示更多/);
	assert.match(text, /进度/);
});

test('manifest 当前版本有对应内置说明，且版本严格递减', () => {
	assert.ok(currentUpdateIntro(manifest.version), `${manifest.version} 必须有内置更新说明`);
	assert.equal(UPDATE_INTROS[0].version, manifest.version, '最新说明必须对应当前发布版本');
	for (let index = 1; index < UPDATE_INTROS.length; index++) {
		const newer = UPDATE_INTROS[index - 1].version.split('.').map(Number);
		const older = UPDATE_INTROS[index].version.split('.').map(Number);
		const isNewer = newer[0] !== older[0] ? newer[0] > older[0]
			: newer[1] !== older[1] ? newer[1] > older[1]
				: newer[2] > older[2];
		assert.ok(isNewer, `${UPDATE_INTROS[index - 1].version} 应排在 ${UPDATE_INTROS[index].version} 之前`);
	}
});

test('1.8.0 内置说明保留（可历史查看），且覆盖性能与安装包', () => {
	const intro = currentUpdateIntro('1.8.0');
	assert.ok(intro, '1.8.0 必须有更新说明条目');
	assert.equal(intro.theme, '全面提速与安装包');
	// 1.9.0 发布后 1.8.0 不再是最新，但仍应保留以便翻看历史。
	assert.notEqual(UPDATE_INTROS[0].version, '1.8.0', '1.8.0 不应再排在最前');
	const text = [intro.summary, ...intro.sections.map((section) => section.title + section.items.join('\n'))].join('\n');
	assert.match(text, /49 倍/);
	assert.match(text, /8 倍/);
	assert.match(text, /\.zip/);
	assert.match(text, /键盘/);
	assert.match(text, /中止扫描/);
	assert.match(text, /焦点/);
});

test('内置说明内容完整可渲染', () => {
	assert.ok(UPDATE_INTROS.length > 0);
	const versions = new Set();
	for (const intro of UPDATE_INTROS) {
		assert.match(intro.version, /^\d+\.\d+\.\d+$/, `版本号格式：${intro.version}`);
		assert.equal(versions.has(intro.version), false, `版本说明不得重复：${intro.version}`);
		versions.add(intro.version);
		assert.ok(intro.theme.trim(), '主题词不能为空');
		assert.ok(intro.summary.trim(), '简介不能为空');
		assert.ok(intro.sections.length > 0, '至少一个更新分类');
		for (const section of intro.sections) {
			assert.ok(section.title.trim(), '分类标题不能为空');
			assert.ok(section.items.length > 0, `分类「${section.title}」不能为空`);
			for (const item of section.items) assert.ok(item.trim(), '要点不能为空');
		}
	}
});
