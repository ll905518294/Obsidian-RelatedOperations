#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取指定版本的更新说明，供 GitHub Release 正文使用。
 *
 * 用法：
 *   node scripts/release-notes.mjs                  # 读取 manifest.json 的当前版本
 *   node scripts/release-notes.mjs --version 1.9.4  # 指定版本（回填旧 release）
 *   node scripts/release-notes.mjs --check          # 只校验条目存在，不输出正文
 *
 * 设计约束：零第三方依赖；找不到对应版本时以非零码退出，避免发布没有说明的版本。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class ReleaseNotesError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ReleaseNotesError';
	}
}

/** 从 CHANGELOG 文本中提取 `## [version]` 到下一个 `## [` 之间的正文。 */
export function extractReleaseSection(changelog, version) {
	const normalized = changelog.replace(/\r\n?/g, '\n');
	const lines = normalized.split('\n');
	const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const heading = new RegExp(`^## \\[${escaped}\\](?:\\s|$)`);
	const start = lines.findIndex((line) => heading.test(line));
	if (start === -1) {
		throw new ReleaseNotesError(`CHANGELOG.md 中找不到版本 ${version} 的条目（期望 ## [${version}]）`);
	}
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index++) {
		if (/^## \[/.test(lines[index])) {
			end = index;
			break;
		}
	}
	const body = lines.slice(start + 1, end).join('\n').trim();
	if (!body) throw new ReleaseNotesError(`版本 ${version} 的 CHANGELOG 条目为空`);
	return body;
}

export function readManifestVersion(root = ROOT) {
	const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
	if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
		throw new ReleaseNotesError('manifest.json 缺少有效的 version');
	}
	return manifest.version;
}

function parseArgs(argv) {
	let version;
	let check = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === '--check') {
			check = true;
		} else if (arg === '--version') {
			version = argv[index + 1];
			if (!version) throw new ReleaseNotesError('--version 缺少版本号');
			index += 1;
		} else {
			throw new ReleaseNotesError(`未知参数：${arg}`);
		}
	}
	return { version, check };
}

function main() {
	const { version, check } = parseArgs(process.argv.slice(2));
	const targetVersion = version ?? readManifestVersion();
	const changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
	const body = extractReleaseSection(changelog, targetVersion);
	if (check) return;
	process.stdout.write(`## 更新说明\n\n${body}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath && import.meta.url === invokedPath) {
	try {
		main();
	} catch (error) {
		console.error(`release-notes: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
