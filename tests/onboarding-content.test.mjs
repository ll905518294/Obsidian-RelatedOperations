import test from 'node:test';
import assert from 'node:assert/strict';
import { ONBOARDING_STEPS, decideStartupIntro } from '../src/onboarding-content.ts';

test('引导包含三步且内容完整', () => {
	assert.equal(ONBOARDING_STEPS.length, 3);
	assert.deepEqual(ONBOARDING_STEPS.map((step) => step.title), ['它能做什么', '安全说明', '怎么开始']);
	for (const step of ONBOARDING_STEPS) {
		assert.ok(step.summary.trim(), `「${step.title}」缺少简介`);
		assert.ok(step.items.length > 0, `「${step.title}」缺少要点`);
		for (const item of step.items) assert.ok(item.text.trim(), `「${step.title}」存在空要点`);
	}
});

test('第一步覆盖 9 类体检、图片转换与关联笔记整理', () => {
	const text = ONBOARDING_STEPS[0].items.map((item) => `${item.text}${item.after ?? ''}`).join('\n');
	assert.match(text, /9 类问题/);
	assert.match(text, /图片转换/);
	assert.match(text, /关联笔记整理/);
});

test('第二步强调只读与两段式删除', () => {
	const text = ONBOARDING_STEPS[1].items.map((item) => item.text).join('\n');
	assert.match(text, /只读/);
	assert.match(text, /两段式确认/);
});

test('第三步包含 + 图标提示与开始扫描入口', () => {
	const third = ONBOARDING_STEPS[2];
	const kbd = third.items.find((item) => item.kbd === '+');
	assert.ok(kbd, '缺少 <kbd>+</kbd> 提示');
	const text = third.items.map((item) => `${item.text}${item.after ?? ''}`).join('\n');
	assert.match(text, /开始扫描/);
});

test('第三步补充图片转换页签与关联笔记整理的入口', () => {
	const text = ONBOARDING_STEPS[2].items.map((item) => item.text).join('\n');
	// 图片转换是体检面板内的页签，关联笔记整理是独立入口（命令/侧栏图标）。
	assert.match(text, /图片转换/);
	assert.match(text, /整理关联笔记/);
});

test('首次安装只弹引导，升级只弹更新说明', () => {
	assert.equal(decideStartupIntro('1.6.0', '', false), 'onboarding', '首次安装应弹引导');
	assert.equal(decideStartupIntro('', '', false), 'none', '缺少版本时不弹');
	assert.equal(decideStartupIntro('1.6.0', '1.6.0', false), 'onboarding', '未看过引导时同版本也弹引导');
	assert.equal(decideStartupIntro('1.6.0', ' v1.6.0 ', true), 'none', '看过引导后同版本不再弹');
});

// The wizard shows until seen, even for vaults upgraded from older releases,
// which already carry a `lastSeenVersion` value in their settings.
test('看过引导后按版本变化决定更新说明，未看过则始终弹引导', () => {
	assert.equal(decideStartupIntro('1.6.1', '1.6.0', true), 'update', '看过引导且版本有变化应弹更新说明');
	assert.equal(decideStartupIntro('1.6.1', '1.6.1', true), 'none', '看过引导且版本相同不再弹');
	assert.equal(decideStartupIntro('1.6.1', '', false), 'onboarding', '新建库未看过引导应弹引导');
	assert.equal(decideStartupIntro('1.6.1', '1.5.0', false), 'onboarding', '升级老用户未看过引导也应弹引导');
});
