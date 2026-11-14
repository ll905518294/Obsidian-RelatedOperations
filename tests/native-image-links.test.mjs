import test from 'node:test';
import assert from 'node:assert/strict';
import { convertNativeImageLink, findNativeImageLinks, replaceNativeImageLinks, revalidateNativeImageLink } from '../src/native-image-links.ts';

const file = (path, basename = path.split('/').at(-1).replace(/\.[^.]+$/, '')) => ({ path, basename });
const link = (original, path, start, extra = {}) => ({ sourcePath: 'note.md', original, linkPath: path, position: { start: { offset: start }, end: { offset: start + original.length } }, file: Object.hasOwn(extra, 'file') ? extra.file : file(path), reason: extra.reason });

test('converts basic and aliased embeds with empty alt text', () => {
	assert.equal(convertNativeImageLink(link('![[folder/a b（示例）.png]]', 'folder/a b（示例）.png', 0)), '![](<folder/a b（示例）.png>)');
	assert.equal(convertNativeImageLink(link('![[image.png|示意图]]', 'image.png', 0)), '![](<image.png>)');
});

test('skips dimensions and unresolved targets', () => {
	assert.equal(convertNativeImageLink(link('![[image.png|300x200]]', 'image.png', 0, { reason: '包含尺寸参数' })), null);
	assert.equal(convertNativeImageLink(link('![[missing.png]]', 'missing.png', 0, { file: undefined })), null);
});

test('marks a raw dimension mixed with an alias as a dimension like a pure dimension', () => {
	const app = (cache) => ({
		vault: { getMarkdownFiles: () => [{ path: 'note.md' }] },
		metadataCache: {
			getFileCache: () => cache,
			getFirstLinkpathDest: () => ({ path: 'image.png' }),
		},
	});
	const embeds = (original) => [{ original, link: 'image.png', position: { start: { offset: 0 }, end: { offset: original.length } } }];
	const mixed = findNativeImageLinks(app({ embeds: embeds('![[image.png|300x200 别名]]') }), 'png');
	assert.equal(convertNativeImageLink(mixed[0]), null);
	const leading = findNativeImageLinks(app({ embeds: embeds('![[image.png|别名 300x200]]') }), 'png');
	assert.equal(convertNativeImageLink(leading[0]), null);
	const pure = findNativeImageLinks(app({ embeds: embeds('![[image.png|300x200]]') }), 'png');
	assert.equal(convertNativeImageLink(pure[0]), null);
	const alias = findNativeImageLinks(app({ embeds: embeds('![[image.png|示意图]]') }), 'png');
	assert.equal(convertNativeImageLink(alias[0]), '![](<image.png>)');
});

test('treats bare width plus alias as a dimension but keeps numeric aliases convertible', () => {
	const app = (cache) => ({
		vault: { getMarkdownFiles: () => [{ path: 'note.md' }] },
		metadataCache: {
			getFileCache: () => cache,
			getFirstLinkpathDest: () => ({ path: 'image.png' }),
		},
	});
	const embeds = (original) => [{ original, link: 'image.png', position: { start: { offset: 0 }, end: { offset: original.length } } }];
	const mixed = findNativeImageLinks(app({ embeds: embeds('![[image.png|300 别名]]') }), 'png');
	assert.equal(convertNativeImageLink(mixed[0]), null);
	const numericAlias = findNativeImageLinks(app({ embeds: embeds('![[image.png|2024版]]') }), 'png');
	assert.equal(convertNativeImageLink(numericAlias[0]), '![](<image.png>)');
});

test('revalidates a target before conversion', () => {
	const stale = link('![[image.png]]', 'image.png', 0);
	const current = revalidateNativeImageLink({ metadataCache: { getFirstLinkpathDest: () => null } }, stale);
	assert.equal(convertNativeImageLink(current), null);
});

test('replaces multiple occurrences from right to left and skips changed content', () => {
	const a = link('![[a.png]]', 'a.png', 0);
	const b = link('![[b.png]]', 'b.png', 11);
	assert.deepEqual(replaceNativeImageLinks('![[a.png]]\n![[b.png]]', [a, b]), { content: '![](<a.png>)\n![](<b.png>)', converted: 2, skipped: 0 });
	assert.deepEqual(replaceNativeImageLinks('changed', [a]), { content: 'changed', converted: 0, skipped: 1 });
});

test('does not replace a different identical embed when the cached position is stale', () => {
	const second = link('![[a.png]]', 'a.png', 11);
	assert.deepEqual(replaceNativeImageLinks('![[a.png]]\nchanged', [second]), { content: '![[a.png]]\nchanged', converted: 0, skipped: 1 });
});
