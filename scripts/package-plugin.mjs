#!/usr/bin/env node
/**
 * 把插件发布产物打包成可重复构建的 ZIP 安装包。
 *
 * 用法：
 *   node scripts/package-plugin.mjs            # 打包到 dist/vault-doctor-<version>.zip
 *   node scripts/package-plugin.mjs --check    # 只校验输入与打包规则，不写任何文件
 *   node scripts/package-plugin.mjs --help
 *
 * 设计约束：
 *   - 零第三方依赖：ZIP 由本文件用 Node 内置能力写入（node:zlib 压缩 + 手工构造文件头）。
 *   - ZIP 内文件位于根层（main.js / manifest.json / styles.css），解压后可直接放进
 *     <Vault>/.obsidian/plugins/vault-doctor/，不额外套一层目录。
 *   - Obsidian 社区分发标准仍是三件套；ZIP 只是本地与 Releases 的便捷打包形式。
 *   - 打包前不会自动构建：main.js 缺失时只提示先执行 npm run build，避免与并行构建冲突。
 *
 * 本文件同时是可导入模块：`tests/package-plugin.test.mjs` 复用 buildZip / inspectZip
 * 做真实打包与损坏检测，因此校验逻辑不依赖脚本自身的返回值。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/** 发布必需文件，顺序即 ZIP 内顺序。 */
export const REQUIRED_FILES = ['main.js', 'manifest.json'];
/** 存在则纳入，缺失不算失败。 */
export const OPTIONAL_FILES = ['styles.css'];

export const SEMVER_RE =
	/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
/** Obsidian 插件 id：小写字母、数字、点、下划线与连字符，不能以分隔符结尾。 */
export const PLUGIN_ID_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?$/;

/** 打包过程中的可预期错误，main() 统一转成非零退出。 */
export class PackagingError extends Error {
	constructor(message) {
		super(message);
		this.name = 'PackagingError';
	}
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** CRC-32 查表，与 ZIP 规范一致（多项式 0xEDB88320）。 */
const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let i = 0; i < 256; i += 1) {
		let value = i;
		for (let bit = 0; bit < 8; bit += 1) {
			value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[i] = value;
	}
	return table;
})();

export function crc32(buffer) {
	let crc = 0 ^ -1;
	for (let i = 0; i < buffer.length; i += 1) {
		crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
	}
	return (crc ^ -1) >>> 0;
}

/** 转成 ZIP 的 DOS 时间/日期字段；年份下限 1980 是 ZIP 能表示的最早值。 */
function toDosDateTime(date) {
	const year = Math.max(date.getFullYear(), 1980);
	const time =
		((date.getHours() & 0x1f) << 11) |
		((date.getMinutes() & 0x3f) << 5) |
		(Math.floor(date.getSeconds() / 2) & 0x1f);
	const day =
		(((year - 1980) & 0x7f) << 9) |
		(((date.getMonth() + 1) & 0xf) << 5) |
		(date.getDate() & 0x1f);
	return { time, date: day };
}

/** 生成一个不含第三方压缩库依赖的 ZIP 文件（支持 deflate 与 store）。 */
export function buildZip(entries) {
	const body = [];
	const central = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBuffer = Buffer.from(entry.name, 'utf8');
		const data = entry.data;
		const crc = crc32(data);

		let payload = deflateRawSync(data);
		let method = 8;
		if (payload.length >= data.length) {
			payload = data;
			method = 0;
		}

		const { time, date } = toDosDateTime(entry.mtime);
		const flags = 0x0800; // 文件名使用 UTF-8

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed to extract
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuffer.length, 26);
		local.writeUInt16LE(0, 28); // extra field length

		body.push(local, nameBuffer, payload);

		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50, 0);
		directory.writeUInt16LE(20, 4); // version made by
		directory.writeUInt16LE(20, 6); // version needed to extract
		directory.writeUInt16LE(flags, 8);
		directory.writeUInt16LE(method, 10);
		directory.writeUInt16LE(time, 12);
		directory.writeUInt16LE(date, 14);
		directory.writeUInt32LE(crc, 16);
		directory.writeUInt32LE(payload.length, 20);
		directory.writeUInt32LE(data.length, 24);
		directory.writeUInt16LE(nameBuffer.length, 28);
		directory.writeUInt16LE(0, 30); // extra field length
		directory.writeUInt16LE(0, 32); // file comment length
		directory.writeUInt16LE(0, 34); // disk number start
		directory.writeUInt16LE(0, 36); // internal file attributes
		directory.writeUInt32LE(0, 38); // external file attributes
		directory.writeUInt32LE(offset, 42);
		central.push(directory, nameBuffer);

		offset += local.length + nameBuffer.length + payload.length;
	}

	const centralDirectory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4); // this disk
	end.writeUInt16LE(0, 6); // disk with central directory
	end.writeUInt16LE(entries.length, 8); // entries on this disk
	end.writeUInt16LE(entries.length, 10); // total entries
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20); // comment length

	return Buffer.concat([...body, centralDirectory, end]);
}

/** 读回 ZIP 并逐项解压校验，确认产物自洽（不只信任刚写进去的内存）。 */
export function inspectZip(buffer) {
	const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
	const endOffset = buffer.lastIndexOf(eocd);
	if (endOffset < 0 || endOffset + 22 > buffer.length) {
		throw new PackagingError('ZIP 缺少完整的中央目录结束记录');
	}

	const count = buffer.readUInt16LE(endOffset + 10);
	const centralSize = buffer.readUInt32LE(endOffset + 12);
	const centralOffset = buffer.readUInt32LE(endOffset + 16);
	if (centralOffset > buffer.length || centralSize > buffer.length - centralOffset) {
		throw new PackagingError('ZIP 中央目录偏移或长度越界');
	}

	const entries = [];
	let cursor = centralOffset;
	for (let i = 0; i < count; i += 1) {
		if (cursor + 46 > buffer.length) throw new PackagingError(`中央目录第 ${i + 1} 项越界`);
		if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
			throw new PackagingError(`中央目录第 ${i + 1} 项签名无效`);
		}
		const method = buffer.readUInt16LE(cursor + 10);
		const crc = buffer.readUInt32LE(cursor + 16);
		const compressedSize = buffer.readUInt32LE(cursor + 20);
		const size = buffer.readUInt32LE(cursor + 24);
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		const localOffset = buffer.readUInt32LE(cursor + 42);
		const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
		cursor += 46 + nameLength + extraLength + commentLength;

		if (localOffset > buffer.length || localOffset + 30 > buffer.length) {
			throw new PackagingError(`${name} 的本地文件头越界`);
		}
		if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
			throw new PackagingError(`${name} 的本地文件头签名无效`);
		}
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		if (dataStart + compressedSize > buffer.length) {
			throw new PackagingError(`${name} 的压缩数据越界`);
		}
		const raw = buffer.subarray(dataStart, dataStart + compressedSize);
		let data;
		try {
			data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
		} catch (error) {
			throw new PackagingError(`${name} 解压失败：${error.message}`);
		}

		if (data.length !== size) {
			throw new PackagingError(`${name} 解压后长度与目录记录不一致`);
		}
		if (crc32(data) !== crc) {
			throw new PackagingError(`${name} 的 CRC-32 校验失败，文件可能已损坏`);
		}
		entries.push({ name, size, method, data });
	}

	if (cursor !== centralOffset + centralSize) {
		throw new PackagingError('中央目录长度与结束记录不一致');
	}
	return entries;
}

export function readVersion(root = ROOT) {
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
	} catch (error) {
		throw new PackagingError(`无法读取 manifest.json：${error.message}`);
	}
	if (typeof manifest.version !== 'string' || !SEMVER_RE.test(manifest.version)) {
		throw new PackagingError(
			`manifest.json 的 version 必须是无 v 前缀的 SemVer，当前为 ${JSON.stringify(manifest.version)}`,
		);
	}
	if (typeof manifest.id !== 'string' || !PLUGIN_ID_RE.test(manifest.id)) {
		throw new PackagingError(
			`manifest.json 的 id 必须是合法的 Obsidian 插件 id，当前为 ${JSON.stringify(manifest.id)}`,
		);
	}
	if (typeof manifest.minAppVersion !== 'string' || !SEMVER_RE.test(manifest.minAppVersion)) {
		throw new PackagingError(
			`manifest.json 的 minAppVersion 必须是 SemVer，当前为 ${JSON.stringify(manifest.minAppVersion)}`,
		);
	}
	return manifest;
}

/**
 * 校验发布清单与仓库其它版本文件一致。
 *
 * 只在文件存在时校验，方便测试用最小项目根目录（只放 manifest + 产物）；
 * 真实仓库里 package.json 与 versions.json 必须同时存在并保持一致。
 */
export function assertVersionConsistency(root, manifest) {
	const packagePath = join(root, 'package.json');
	if (existsSync(packagePath)) {
		let pkg;
		try {
			pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
		} catch (error) {
			throw new PackagingError(`package.json 无法解析：${error.message}`);
		}
		if (pkg.version !== manifest.version) {
			throw new PackagingError(
				`版本不一致：manifest.json 为 ${manifest.version}，package.json 为 ${JSON.stringify(pkg.version)}`,
			);
		}
	}

	const versionsPath = join(root, 'versions.json');
	if (existsSync(versionsPath)) {
		let versions;
		try {
			versions = JSON.parse(readFileSync(versionsPath, 'utf8'));
		} catch (error) {
			throw new PackagingError(`versions.json 无法解析：${error.message}`);
		}
		if (versions[manifest.version] !== manifest.minAppVersion) {
			throw new PackagingError(
				`versions.json 必须把 ${manifest.version} 映射到 minAppVersion ${manifest.minAppVersion}，当前为 ${JSON.stringify(versions[manifest.version])}`,
			);
		}
	}
}

export function collectEntries(root = ROOT) {
	const manifest = readVersion(root);
	assertVersionConsistency(root, manifest);
	const entries = [];

	const take = (name, required) => {
		const path = join(root, name);
		if (!existsSync(path)) {
			if (required) {
				throw new PackagingError(`缺少必需文件 ${name}；请先运行 npm run build 再打包`);
			}
			return;
		}
		const info = statSync(path);
		if (!info.isFile() || info.size === 0) {
			throw new PackagingError(`${name} 不是有效的非空文件`);
		}
		entries.push({ name, data: readFileSync(path), mtime: info.mtime });
	};

	for (const name of REQUIRED_FILES) take(name, true);
	for (const name of OPTIONAL_FILES) take(name, false);

	return { manifest, entries };
}

/** 打包完成后自检：条目集合、大小、以及 ZIP 内 manifest 版本与文件名一致。 */
export function verifyEntries(manifest, entries, zipBuffer) {
	const inspected = inspectZip(zipBuffer);
	const expected = entries.map((entry) => entry.name);
	const actual = inspected.map((entry) => entry.name);

	for (const name of expected) {
		if (!actual.includes(name)) throw new PackagingError(`ZIP 缺少文件 ${name}`);
	}
	for (const name of actual) {
		if (!expected.includes(name)) {
			throw new PackagingError(`ZIP 含多余文件 ${name}，安装包只应包含发布三件套`);
		}
	}
	for (const entry of entries) {
		const fromZip = inspected.find((item) => item.name === entry.name);
		if (fromZip.size !== entry.data.length) {
			throw new PackagingError(`ZIP 内 ${entry.name} 大小与源文件不一致`);
		}
		if (fromZip.data.equals(entry.data) === false) {
			throw new PackagingError(`ZIP 内 ${entry.name} 内容与源文件不一致`);
		}
	}

	let nested;
	try {
		nested = JSON.parse(inspected.find((item) => item.name === 'manifest.json').data.toString('utf8'));
	} catch (error) {
		throw new PackagingError(`ZIP 内 manifest.json 无法解析：${error.message}`);
	}
	if (nested.version !== manifest.version) {
		throw new PackagingError(`ZIP 内 manifest.json 版本 ${nested.version} 与文件名版本 ${manifest.version} 不一致`);
	}
}

function main() {
	const args = process.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) {
		process.stdout.write(
			'用法：node scripts/package-plugin.mjs [--check]\n' +
			'  （无参数）打包并写出 dist/vault-doctor-<version>.zip\n' +
			'  --check   只校验输入文件与打包规则，不写任何文件\n',
		);
		return;
	}
	const unknown = args.find((arg) => arg.startsWith('-') && arg !== '--check');
	if (unknown) throw new PackagingError(`未知参数：${unknown}`);
	if (args.filter((arg) => arg === '--check').length > 1) throw new PackagingError('--check 只能出现一次');

	const checkOnly = args.includes('--check');
	const { manifest, entries } = collectEntries();
	const zipBuffer = buildZip(entries);
	verifyEntries(manifest, entries, zipBuffer);

	if (checkOnly) {
	process.stdout.write(
			`校验通过：${entries.length} 个文件将进入 ${manifest.id}-${manifest.version}.zip（--check 未写出）\n`,
		);
		return;
	}

	const outputDir = join(ROOT, 'dist');
	mkdirSync(outputDir, { recursive: true });
	const outputPath = join(outputDir, `${manifest.id}-${manifest.version}.zip`);
	writeFileSync(outputPath, zipBuffer);

	const sha256 = createHash('sha256').update(zipBuffer).digest('hex');
	const kilobytes = (Buffer.byteLength(zipBuffer) / 1024).toFixed(1);
	process.stdout.write(
		`已生成 ${outputPath}\n` +
		`  文件：${entries.map((entry) => entry.name).join('、')}\n` +
		`  体积：${kilobytes} KB\n` +
		`  SHA-256：${sha256}\n`,
	);
}

const executedDirectly =
	Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (executedDirectly) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`打包失败：${error.message}\n`);
		process.exit(1);
	}
}
