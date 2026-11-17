#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取指定版本的更新说明，供 GitHub Release 正文使用。
 * 找不到 CHANGELOG 段落时回退到该版本 tag 的提交标题，不编造内容。
 *
 * 用法：
 *   node scripts/release-notes.mjs                  # 读取 manifest.json 的当前版本
 *   node scripts/release-notes.mjs --version 1.9.4  # 指定版本（回填旧 release）
 *   node scripts/release-notes.mjs --check          # 只校验条目存在，不输出正文
 *
 * 支持标题：
 *   ## [1.9.4] — ...
 *   ### 2026-11-15 — 1.4.5：...
 *   ### 1.6.0–1.6.3：...（命中区间内任一版本）
 *   ### 1.5.0：...
 *
 * 设计约束：零第三方依赖；条目与提交记录都不存在时以非零码退出。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export class ReleaseNotesError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ReleaseNotesError';
	}
}

export function normalizeVersion(value) {
	return String(value ?? '').trim().replace(/^v/, '');
}

function versionParts(version) {
	const match = VERSION_RE.exec(version);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersionParts(left, right) {
	for (let index = 0; index < 3; index++) {
		if (left[index] < right[index]) return -1;
		if (left[index] > right[index]) return 1;
	}
	return 0;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchHeading(line, version) {
	const heading = /^(#{2,6})\s+(.*)$/.exec(line);
	if (!heading) return null;
	const level = heading[1].length;
	const text = heading[2].trim();
	let match;

	match = /^\[v?(\d+\.\d+\.\d+)\](?:\s|$)/.exec(text);
	if (match) return match[1] === version ? level : null;

	match = /^v?(\d+\.\d+\.\d+)\s*[–—-]\s*v?(\d+\.\d+\.\d+)\s*[：:]/.exec(text);
	if (match) {
		const current = versionParts(version);
		const start = versionParts(match[1]);
		const end = versionParts(match[2]);
		if (!current || !start || !end) return null;
		return compareVersionParts(current, start) >= 0 && compareVersionParts(current, end) <= 0
			? level
			: null;
	}

	match = /^\d{4}-\d{2}-\d{2}\s*[—–-]\s*v?(\d+\.\d+\.\d+)\s*[：:]/.exec(text);
	if (match) return match[1] === version ? level : null;

	match = /^v?(\d+\.\d+\.\d+)\s*[：:]/.exec(text);
	if (match) return match[1] === version ? level : null;

	// 兜底识别「2026-11-14 — 发布准备：更名 Vault Doctor 并升级至 1.3.0」这类标题。
	if (/^\d{4}-\d{2}-\d{2}\s*[—–-]/.test(text)) {
		const token = new RegExp(`(?:^|[^0-9.])v?${escapeRegExp(version)}(?![0-9.])`);
		if (token.test(text)) return level;
	}

	return null;
}

export function findReleaseSection(changelog, version) {
	const normalized = changelog.replace(/\r\n?/g, '\n');
	const lines = normalized.split('\n');
	for (let start = 0; start < lines.length; start++) {
		const level = matchHeading(lines[start], version);
		if (!level) continue;
		let end = lines.length;
		for (let index = start + 1; index < lines.length; index++) {
			const nextHeading = /^(#{1,6})\s+/.exec(lines[index]);
			if (nextHeading && nextHeading[1].length <= level) {
				end = index;
				break;
			}
		}
		return {
			body: lines.slice(start + 1, end).join('\n').trim(),
			heading: lines[start].trim(),
			level,
		};
	}
	return null;
}

/** 从 CHANGELOG 文本中提取版本正文；找不到或为空时抛出。 */
export function extractReleaseSection(changelog, version) {
	const section = findReleaseSection(changelog, version);
	if (!section) {
		throw new ReleaseNotesError(
			`CHANGELOG.md 中找不到版本 ${version} 的条目（支持 ## [版本]、### 日期 — 版本：...、### 版本–版本：...、### 版本：...）`,
		);
	}
	if (!section.body) throw new ReleaseNotesError(`版本 ${version} 的 CHANGELOG 条目为空`);
	return section.body;
}

export function readManifestVersion(root = ROOT) {
	const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
	const version = normalizeVersion(manifest.version);
	if (!VERSION_RE.test(version)) {
		throw new ReleaseNotesError('manifest.json 缺少有效的 version');
	}
	return version;
}

function gitOutput(root, args) {
	return execFileSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
	}).trim();
}

export function findPreviousTag(root, tag) {
	try {
		return gitOutput(root, ['describe', '--tags', '--abbrev=0', `${tag}^`]) || null;
	} catch {
		return null;
	}
}

export function collectCommitSubjects(root, tag) {
	if (!VERSION_RE.test(tag)) return [];
	try {
		const previous = findPreviousTag(root, tag);
		const range = previous ? `${previous}..${tag}` : tag;
		const output = gitOutput(root, ['log', range, '--pretty=format:- %s']);
		return output
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * 返回可直接放入 Release 正文的更新说明。
 * source: changelog | git-log | empty
 */
export function buildReleaseNotes(version, options = {}) {
	const root = options.root ?? ROOT;
	const target = normalizeVersion(version);
	if (!VERSION_RE.test(target)) throw new ReleaseNotesError(`版本号不合法：${version}`);

	let changelog = options.changelog;
	if (changelog === undefined) {
		try {
			changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
		} catch {
			changelog = '';
		}
	}

	const section = findReleaseSection(changelog, target);
	if (section?.body) {
		return { version: target, body: section.body, source: 'changelog' };
	}

	const subjects = options.commitSubjects ?? collectCommitSubjects(root, target);
	if (subjects.length > 0) {
		return {
			version: target,
			body: `本版本提交记录（自动生成）\n\n${subjects.join('\n')}`,
			source: 'git-log',
		};
	}

	return { version: target, body: '该版本未记录更新说明', source: 'empty' };
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
	const target = normalizeVersion(version ?? readManifestVersion());
	const notes = buildReleaseNotes(target);
	if (notes.source === 'empty') {
		throw new ReleaseNotesError(
			`CHANGELOG.md 中找不到版本 ${target} 的条目，且没有可用提交记录（该版本未记录更新说明）`,
		);
	}
	if (check) return;
	process.stdout.write(`## 更新说明\n\n${notes.body}\n`);
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
