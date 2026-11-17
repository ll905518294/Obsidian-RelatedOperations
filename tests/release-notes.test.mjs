import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractReleaseSection } from '../scripts/release-notes.mjs';

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
