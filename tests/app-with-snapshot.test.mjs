import test from 'node:test';
import assert from 'node:assert/strict';
import { appWithSnapshot } from '../src/image-convert/image-convert-runner.ts';

/**
 * Guard: 真实 Obsidian 的 Vault 方法（getFiles、getAbstractFileByPath 等）位于原型上，
 * 而非自有可枚举属性。包装 vault 时若用对象展开 `{...app.vault}` 会丢失原型链，
 * 导致 `app.vault.getFiles` 在真实宿主抛 "not a function"。
 * 这里用「方法定义在原型上」的桩复现，确认包装后：
 *  1. 原型方法仍可调用（this 绑定正确）；
 *  2. read 优先走快照，miss 时回退原 read 且 this 不丢。
 */

function protoVault(store) {
	const proto = {
		getFiles() {
			return this.files();
		},
		getAbstractFileByPath(path) {
			return this.resolve(path);
		},
		read(file) {
			this.readCalls.push(file.path);
			return `fromDisk:${file.path}`;
		},
	};
	const vault = Object.create(proto);
	Object.assign(vault, {
		files: () => [...store.values()],
		resolve: (path) => store.get(path) ?? null,
		readCalls: [],
	});
	return vault;
}

test('包装 vault 继承原型方法（getFiles/getAbstractFileByPath），read 优先走快照', async () => {
	const store = new Map([
		['note.md', { path: 'note.md', content: 'snapshot content' }],
		['other.md', { path: 'other.md', content: 'from disk' }],
	]);
	const vault = protoVault(store);

	const app = {
		vault,
		metadataCache: { resolvedLinks: {} },
	};
	const snapshot = new Map([['note.md', 'cached content']]);

	const wrapped = appWithSnapshot(app, snapshot);

	// 原型方法在包装对象上仍可调用且作用于原始 vault 状态
	assert.equal(typeof wrapped.vault.getFiles, 'function', 'getFiles 必须通过原型链可用');
	assert.equal(wrapped.vault.getFiles().length, 2);
	assert.equal(wrapped.vault.getAbstractFileByPath('note.md').path, 'note.md');

	// read 快照命中优先，不再真读盘
	assert.equal(await wrapped.vault.read(store.get('note.md')), 'cached content');
	assert.deepEqual(vault.readCalls, [], '快照命中时不得回退到真实读盘');

	// read miss 时回退到原 read，this 绑定正确（能访问 readCalls）
	assert.equal(await wrapped.vault.read(store.get('other.md')), 'fromDisk:other.md');
	assert.deepEqual(vault.readCalls, ['other.md'], 'miss 时回退原 read 且 this 正常');
});
