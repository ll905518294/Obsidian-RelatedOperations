import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	rmdirSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildZip, crc32, inspectZip, PackagingError } from '../scripts/package-plugin.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/package-plugin.mjs', import.meta.url));

/** 逐个删除测试自建目录，避免任何递归批量删除。 */
function removeTree(target) {
	if (!existsSync(target)) return;
	if (!statSync(target).isDirectory()) {
		rmSync(target, { force: true });
		return;
	}
	for (const child of readdirSync(target)) {
		removeTree(join(target, child));
	}
	rmdirSync(target);
}

/** 复制脚本到临时项目目录，并写入一份假的发布产物。 */
function makeProject({ version = '1.2.3', withStyles = true, withMain = true } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'vault-doctor-package-'));
	const scriptsDir = join(dir, 'scripts');
	mkdirSync(scriptsDir, { recursive: true });
	copyFileSync(SCRIPT, join(scriptsDir, 'package-plugin.mjs'));

	const manifest = JSON.stringify({ id: 'vault-doctor', name: 'Vault Doctor', version }, null, 2);
	writeFileSync(join(dir, 'manifest.json'), manifest);
	if (withMain) writeFileSync(join(dir, 'main.js'), '// fake bundle\n');
	if (withStyles) writeFileSync(join(dir, 'styles.css'), '/* fake styles */\n');

	return {
		dir,
		script: join(scriptsDir, 'package-plugin.mjs'),
		zip: join(dir, 'dist', `vault-doctor-${version}.zip`),
		cleanup: () => removeTree(dir),
	};
}

function runScript(project, args = []) {
	return spawnSync(process.execPath, [project.script, ...args], { encoding: 'utf8' });
}

test('buildZip 写出的 ZIP 能被独立解析回来，且条目位于根层', () => {
	const entries = [
		{ name: 'main.js', data: Buffer.from('console.log("hello")'), mtime: new Date() },
		{ name: 'manifest.json', data: Buffer.from('{"version":"1.0.0"}'), mtime: new Date() },
	];
	const zip = buildZip(entries);
	const inspected = inspectZip(zip);

	assert.deepEqual(
		inspected.map((entry) => entry.name),
		['main.js', 'manifest.json'],
	);
	for (let i = 0; i < entries.length; i += 1) {
		assert.equal(inspected[i].data.length, entries[i].data.length);
		assert.ok(inspected[i].data.equals(entries[i].data));
		assert.equal(inspected[i].name.includes('/'), false);
	}
});

test('buildZip 对不可压缩内容回退到 store 且仍能还原', () => {
	const random = randomBytes(512);
	const zip = buildZip([{ name: 'main.js', data: random, mtime: new Date() }]);
	const inspected = inspectZip(zip);
	assert.equal(inspected[0].method, 0);
	assert.ok(inspected[0].data.equals(random));
});

test('inspectZip 对损坏的 ZIP 抛出 PackagingError 而不是裸异常', () => {
	const data = randomBytes(64);
	const zip = buildZip([{ name: 'main.js', data, mtime: new Date() }]);
	assert.deepEqual(inspectZip(zip).map((entry) => entry.name), ['main.js']);

	// 破坏文件内容（store 模式，数据起点为 30 + 7）-> CRC-32 校验失败
	const corruptedData = Buffer.from(zip);
	corruptedData[37] ^= 0xff;
	assert.throws(() => inspectZip(corruptedData), (error) => {
		assert.equal(error instanceof PackagingError, true);
		assert.match(error.message, /CRC-32/);
		return true;
	});

	// 破坏中央目录长度 -> 越界
	const corruptedSize = Buffer.from(zip);
	corruptedSize[corruptedSize.length - 10] = 0xff;
	assert.throws(() => inspectZip(corruptedSize), (error) => {
		assert.equal(error instanceof PackagingError, true);
		assert.match(error.message, /越界/);
		return true;
	});

	// 截断 -> 结束记录不完整
	assert.throws(() => inspectZip(zip.subarray(0, 10)), (error) => error instanceof PackagingError);
});

test('crc32 与已知 ZIP CRC 值一致', () => {
	assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('打包生成 dist/vault-doctor-<version>.zip，内容为发布三件套', (t) => {
	const project = makeProject();
	t.after(project.cleanup);

	const result = runScript(project);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(project.zip), true);

	const inspected = inspectZip(readFileSync(project.zip));
	assert.deepEqual(
		inspected.map((entry) => entry.name),
		['main.js', 'manifest.json', 'styles.css'],
	);
	assert.equal(JSON.parse(inspected[1].data.toString('utf8')).version, '1.2.3');
	assert.equal(inspected[0].data.toString('utf8'), '// fake bundle\n');
});

test('重复打包覆盖同名 ZIP，不追加旧条目', (t) => {
	const project = makeProject();
	t.after(project.cleanup);

	assert.equal(runScript(project).status, 0);
	const first = readFileSync(project.zip);
	assert.equal(runScript(project).status, 0);
	const second = readFileSync(project.zip);

	assert.deepEqual(
		inspectZip(second).map((entry) => entry.name),
		['main.js', 'manifest.json', 'styles.css'],
	);
	assert.equal(inspectZip(first).length, inspectZip(second).length);
});

test('styles.css 缺失时仍能打包，只含两个文件', (t) => {
	const project = makeProject({ withStyles: false });
	t.after(project.cleanup);

	const result = runScript(project);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(
		inspectZip(readFileSync(project.zip)).map((entry) => entry.name),
		['main.js', 'manifest.json'],
	);
});

test('--check 只校验，不写出 ZIP', (t) => {
	const project = makeProject();
	t.after(project.cleanup);

	const result = runScript(project, ['--check']);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(project.zip), false);
	assert.equal(existsSync(join(project.dir, 'dist')), false);
});

test('main.js 缺失时失败并提示先构建，不产出 ZIP', (t) => {
	const project = makeProject({ withMain: false });
	t.after(project.cleanup);

	const result = runScript(project);
	assert.notEqual(result.status, 0);
	assert.equal(existsSync(project.zip), false);
	assert.match(result.stderr, /npm run build/);
});

test('版本号带 v 前缀时拒绝打包', (t) => {
	const project = makeProject({ version: 'v1.2.3' });
	t.after(project.cleanup);

	const result = runScript(project);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /SemVer/);
});

test('版本号不是完整 SemVer 时拒绝打包', (t) => {
	const project = makeProject({ version: '1.2' });
	t.after(project.cleanup);

	const result = runScript(project);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /SemVer/);
});

test('未知参数直接失败', (t) => {
	const project = makeProject();
	t.after(project.cleanup);

	const result = runScript(project, ['--nope']);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /未知参数/);
});

test('从任意工作目录执行都能在脚本所属项目根目录产出 ZIP', (t) => {
	const project = makeProject();
	t.after(project.cleanup);

	const result = spawnSync(process.execPath, [project.script], {
		encoding: 'utf8',
		cwd: tmpdir(),
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(project.zip), true);
});
