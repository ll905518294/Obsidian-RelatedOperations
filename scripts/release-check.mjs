#!/usr/bin/env node
/**
 * 发版前一站式校验：版本号、CHANGELOG/发布说明、内置更新说明与 manifest 格式。
 *
 * 用法：
 *   node scripts/release-check.mjs            # 校验 manifest.json 的当前版本
 *   node scripts/release-check.mjs 1.9.4      # 校验指定 tag/版本
 *
 * 零第三方依赖；任一项失败都会打印原因并以非零码退出。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReleaseNotes } from './release-notes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const PLUGIN_ID_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?$/;

export class ReleaseCheckError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ReleaseCheckError';
	}
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readJson(root, file) {
	return JSON.parse(readFileSync(resolve(root, file), 'utf8'));
}

function readText(root, file) {
	return readFileSync(resolve(root, file), 'utf8');
}

/**
 * @returns {{ version: string, errors: string[], warnings: string[], notesSource: string|null }}
 */
export function checkRelease({ root = ROOT, tag, commitSubjects } = {}) {
	const errors = [];
	const warnings = [];
	const add = (message) => errors.push(message);

	let manifest;
	let pkg;
	let lock;
	let versions;
	try {
		manifest = readJson(root, 'manifest.json');
	} catch (error) {
		add(`manifest.json 无法读取或不是合法 JSON：${error.message}`);
	}
	try {
		pkg = readJson(root, 'package.json');
	} catch (error) {
		add(`package.json 无法读取或不是合法 JSON：${error.message}`);
	}
	try {
		lock = readJson(root, 'package-lock.json');
	} catch (error) {
		add(`package-lock.json 无法读取或不是合法 JSON：${error.message}`);
	}
	try {
		versions = readJson(root, 'versions.json');
	} catch (error) {
		add(`versions.json 无法读取或不是合法 JSON：${error.message}`);
	}

	if (!manifest) {
		return { version: '', errors, warnings, notesSource: null };
	}

	const manifestVersion = typeof manifest.version === 'string' ? manifest.version.trim() : '';
	const expectedTag = tag === undefined ? manifestVersion : String(tag);

	if (typeof manifest.id !== 'string' || !PLUGIN_ID_RE.test(manifest.id)) {
		add(`manifest.id 不是合法的 Obsidian 插件 id：${JSON.stringify(manifest.id)}`);
	}
	if (!VERSION_RE.test(manifestVersion)) {
		add(`manifest.version 必须是 SemVer（如 1.0.1）：${JSON.stringify(manifest.version)}`);
	}
	if (typeof manifest.minAppVersion !== 'string' || !VERSION_RE.test(manifest.minAppVersion)) {
		add(
			`manifest.minAppVersion 必须是 SemVer：${JSON.stringify(manifest.minAppVersion)}`,
		);
	}

	if (tag !== undefined && expectedTag !== manifestVersion) {
		add(`tag/参数 ${expectedTag} 与 manifest.version ${manifestVersion} 不一致（不要带 v 前缀）`);
	}

	if (pkg && pkg.version !== manifestVersion) {
		add(`package.json version ${pkg.version} 与 manifest.version ${manifestVersion} 不一致`);
	}

	if (lock) {
		const lockVersions = [lock.version, lock.packages?.['']?.version].filter(
			(value) => typeof value === 'string',
		);
		if (lockVersions.length === 0) {
			add('package-lock.json 缺少根版本（version 或 packages[""].version）');
		}
		for (const version of new Set(lockVersions)) {
			if (version !== manifestVersion) {
				add(`package-lock.json 根版本 ${version} 与 manifest.version ${manifestVersion} 不一致`);
			}
		}
	}

	if (versions && versions[manifestVersion] !== manifest.minAppVersion) {
		add(
			`versions.json 必须把 ${manifestVersion} 映射到 minAppVersion ${manifest.minAppVersion}，实际为 ${JSON.stringify(versions[manifestVersion])}`,
		);
	}

	let notesSource = null;
	if (VERSION_RE.test(manifestVersion)) {
		try {
			const notes = buildReleaseNotes(manifestVersion, { root, commitSubjects });
			notesSource = notes.source;
			if (notes.source === 'empty') {
				add(`CHANGELOG 与提交记录都没有版本 ${manifestVersion} 的更新说明`);
			} else if (notes.source === 'git-log') {
				warnings.push(`CHANGELOG 缺少 ${manifestVersion} 条目，发布将回退为提交记录`);
			}
		} catch (error) {
			add(`无法生成发布说明：${error.message}`);
		}

		try {
			const intro = readText(root, 'src/update-intro-content.ts');
			const pattern = new RegExp(
				"version:\\s*['\"`]" + escapeRegExp(manifestVersion) + "['\"`]",
			);
			if (!pattern.test(intro)) {
				add(`src/update-intro-content.ts 缺少 version: '${manifestVersion}' 条目`);
			}
		} catch (error) {
			add(`src/update-intro-content.ts 无法读取：${error.message}`);
		}
	}

	return { version: manifestVersion, errors, warnings, notesSource };
}

function main() {
	const args = process.argv.slice(2);
	if (args.length > 1) throw new ReleaseCheckError(`只接受一个 tag/版本参数，收到：${args.join(' ')}`);
	const result = checkRelease({ root: ROOT, tag: args[0] });
	for (const warning of result.warnings) console.warn(`release-check: ${warning}`);
	if (result.errors.length > 0) {
		for (const error of result.errors) console.error(`release-check: ${error}`);
		process.exitCode = 1;
		return;
	}
	console.log(`release-check: ${result.version} 通过（发布说明来源：${result.notesSource}）`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath && import.meta.url === invokedPath) {
	try {
		main();
	} catch (error) {
		console.error(`release-check: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
