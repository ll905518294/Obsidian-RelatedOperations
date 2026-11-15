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

test('第一步覆盖 9 类体检与关联笔记整理', () => {
	const text = ONBOARDING_STEPS[0].items.map((item) => `${item.text}${item.after ?? ''}`).join('\n');
	assert.match(text, /9 类问题/);
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

test('首次安装只弹引导，升级只弹更新说明', () => {
	assert.equal(decideStartupIntro('1.6.0', '', false), 'onboarding', '首次安装应弹引导');
	assert.equal(decideStartupIntro('1.6.0', '', true), 'none', '关闭开关后首次安装不再自动弹');
	assert.equal(decideStartupIntro('1.6.0', '1.5.0', false), 'update', '升级用户应弹更新说明');
	assert.equal(decideStartupIntro('1.6.0', '1.6.0', false), 'none', '同版本不再弹');
	assert.equal(decideStartupIntro('', '', false), 'none', '缺少版本时不弹');
	assert.equal(decideStartupIntro('1.6.0', ' v1.6.0 ', false), 'none', '前导 v 与空白不应误判为升级');
});

// Vaults upgraded from releases older than `lastSeenVersion` also have an empty
// value, but they are existing users and must get the update notes, not the
// first-install wizard.
test('有历史设置但缺少 lastSeenVersion 的老用户按升级处理', () => {
	assert.equal(decideStartupIntro('1.6.0', '', false, true), 'update');
	assert.equal(decideStartupIntro('1.6.0', '', true, true), 'update');
	assert.equal(decideStartupIntro('1.6.0', '1.6.0', false, true), 'none');
});
