import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRelease } from '../scripts/release-check.mjs';

function writeProject(overrides = {}) {
	const root = mkdtempSync(join(tmpdir(), 'vault-doctor-release-check-'));
	const version = overrides.version ?? '1.2.3';
	const manifest = {
		id: 'vault-doctor',
		name: 'Vault Doctor',
		version,
		minAppVersion: '1.13.0',
		isDesktopOnly: true,
		...overrides.manifest,
	};
	const packageVersion = overrides.packageVersion ?? version;
	const lockVersion = overrides.lockVersion ?? version;
	const versionsMap = overrides.versionsMap ?? { [version]: manifest.minAppVersion };

	writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
	writeFileSync(join(root, 'package.json'), JSON.stringify({ version: packageVersion }));
	writeFileSync(
		join(root, 'package-lock.json'),
		JSON.stringify({
			version: lockVersion,
			packages: { '': { version: lockVersion } },
		}),
	);
	writeFileSync(join(root, 'versions.json'), JSON.stringify(versionsMap));
	writeFileSync(
		join(root, 'CHANGELOG.md'),
		overrides.changelog ?? `## [${version}]\n\n- 测试更新\n`,
	);
	mkdirSync(join(root, 'src'), { recursive: true });
	writeFileSync(
		join(root, 'src', 'update-intro-content.ts'),
		overrides.updateIntro ?? `export const UPDATE_INTROS = [{ version: '${version}' }];\n`,
	);

	return root;
}

function cleanup(t, root) {
	t.after(() => rmSync(root, { recursive: true, force: true }));
}

test('版本、发布说明与内置更新说明齐全时通过', (t) => {
	const root = writeProject();
	cleanup(t, root);
	const result = checkRelease({ root, tag: '1.2.3', commitSubjects: [] });
	assert.deepEqual(result.errors, []);
	assert.equal(result.version, '1.2.3');
	assert.equal(result.notesSource, 'changelog');
});

test('package.json 版本与 manifest 不一致时失败', (t) => {
	const root = writeProject({ packageVersion: '1.2.2' });
	cleanup(t, root);
	const result = checkRelease({ root, tag: '1.2.3', commitSubjects: [] });
	assert.ok(result.errors.some((message) => message.includes('package.json version 1.2.2')));
});

test('CHANGELOG 与提交记录都没有该版本时失败', (t) => {
	const root = writeProject({ changelog: '' });
	cleanup(t, root);
	const result = checkRelease({ root, tag: '1.2.3', commitSubjects: [] });
	assert.ok(
		result.errors.some((message) => message.includes('没有版本 1.2.3 的更新说明')),
		result.errors.join('\n'),
	);
});

test('内置更新说明缺少当前版本时失败', (t) => {
	const root = writeProject({ updateIntro: 'export const UPDATE_INTROS = [];\n' });
	cleanup(t, root);
	const result = checkRelease({ root, tag: '1.2.3', commitSubjects: [] });
	assert.ok(
		result.errors.some((message) =>
			message.includes("update-intro-content.ts 缺少 version: '1.2.3'"),
		),
		result.errors.join('\n'),
	);
});

test('tag 与 manifest 版本不一致时失败，带 v 前缀也不接受', (t) => {
	const root = writeProject();
	cleanup(t, root);
	const result = checkRelease({ root, tag: 'v1.2.3', commitSubjects: [] });
	assert.ok(
		result.errors.some((message) => message.includes('与 manifest.version 1.2.3 不一致')),
		result.errors.join('\n'),
	);
});

test('package-lock 根版本不一致时失败', (t) => {
	const root = writeProject({ lockVersion: '1.2.1' });
	cleanup(t, root);
	const result = checkRelease({ root, tag: '1.2.3', commitSubjects: [] });
	assert.ok(
		result.errors.some((message) =>
			message.includes('package-lock.json 根版本 1.2.1'),
		),
		result.errors.join('\n'),
	);
});
