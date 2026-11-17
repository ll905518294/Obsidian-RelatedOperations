import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
	buildReleaseNotes,
	extractReleaseSection,
	findReleaseSection,
} from '../scripts/release-notes.mjs';

const script = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));

function run(args) {
	return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
}

test('提取 1.9.4 段落，且不包含下一个版本内容', () => {
	const result = run(['--version', '1.9.4']);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^## 更新说明/);
	assert.match(result.stdout, /分页渲染/);
	assert.match(result.stdout, /就地更新/);
	assert.doesNotMatch(result.stdout, /补齐 1\.9\.1/);
	assert.doesNotMatch(result.stdout, /## \[1\.9\.3\]/);
});

test('版本不存在时以非零码退出并给出明确错误', () => {
	const result = run(['--version', '9.9.9']);
	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, '');
	assert.match(result.stderr, /找不到版本 9\.9\.9/);
});

test('提取在下一个二级标题处停止', () => {
	const changelog = [
		'## [2.0.0] — 示例',
		'',
		'- 新版本条目',
		'',
		'## [1.9.9] — 示例',
		'',
		'- 旧版本条目',
	].join('\n');
	assert.equal(extractReleaseSection(changelog, '2.0.0'), '- 新版本条目');
});

test('--check 成功时不输出正文', () => {
	const result = run(['--version', '1.9.4', '--check']);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, '');
});

test('支持日期前缀、版本区间、简单版本与标题内版本号', () => {
	const changelog = [
		'## [2.0.0]',
		'',
		'- 方括号条目',
		'',
		'### 2026-11-15 — 1.4.5：日期前缀',
		'',
		'- 日期条目',
		'',
		'### 1.6.0–1.6.3：版本区间',
		'',
		'- 区间条目',
		'',
		'### 1.5.0：简单版本',
		'',
		'- 简单条目',
		'',
		'### 2026-11-14 — 发布准备：升级至 1.3.0',
		'',
		'- 标题内含版本',
	].join('\n');

	assert.equal(extractReleaseSection(changelog, '1.4.5'), '- 日期条目');
	assert.equal(extractReleaseSection(changelog, '1.5.0'), '- 简单条目');
	assert.equal(extractReleaseSection(changelog, '1.6.1'), '- 区间条目');
	assert.equal(extractReleaseSection(changelog, '1.3.0'), '- 标题内含版本');
	assert.equal(findReleaseSection(changelog, '1.6.4'), null);
});

test('CHANGELOG 缺失时回退到该版本的提交标题', () => {
	const notes = buildReleaseNotes('1.3.1', {
		changelog: '',
		commitSubjects: ['- 发布：升级至 1.3.1', '- 文档：记录扫描提速'],
	});
	assert.equal(notes.source, 'git-log');
	assert.match(notes.body, /本版本提交记录（自动生成）/);
	assert.match(notes.body, /- 发布：升级至 1\.3\.1/);
});

test('条目与提交记录都不存在时明确说明未记录', () => {
	const notes = buildReleaseNotes('9.9.9', { changelog: '', commitSubjects: [] });
	assert.equal(notes.source, 'empty');
	assert.equal(notes.body, '该版本未记录更新说明');
});
