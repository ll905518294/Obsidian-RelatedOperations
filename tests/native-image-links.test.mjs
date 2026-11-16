import test from 'node:test';
import assert from 'node:assert/strict';
import { convertNativeImageLink, findNativeImageLinks, nativeImageLinkOffset, replaceNativeImageLinks, revalidateNativeImageLink } from '../src/native-image-links.ts';

const file = (path, basename = path.split('/').at(-1).replace(/\.[^.]+$/, '')) => ({ path, basename });
const link = (original, path, start, extra = {}) => ({ sourcePath: 'note.md', original, linkPath: path, position: { start: { offset: start }, end: { offset: start + original.length } }, file: Object.hasOwn(extra, 'file') ? extra.file : file(path), reason: extra.reason });

test('converts basic embeds and preserves alias text as alt text', () => {
	assert.equal(convertNativeImageLink(link('![[folder/a b（示例）.png]]', 'folder/a b（示例）.png', 0)), '![](<folder/a b（示例）.png>)');
	assert.equal(convertNativeImageLink(link('![[image.png|示意图]]', 'image.png', 0)), '![示意图](<image.png>)');
});

test('parses escaped pipe aliases used inside tables', () => {
	const original = '![[image.png\\|示意图]]';
	const app = {
		vault: { getMarkdownFiles: () => [{ path: 'note.md' }] },
		metadataCache: {
			getFileCache: () => ({
				embeds: [{ original, link: 'image.png', position: { start: { offset: 0 }, end: { offset: original.length } } }],
			}),
			getFirstLinkpathDest: (path) => (path === 'image.png' ? { path: 'image.png' } : null),
		},
	};
	const found = findNativeImageLinks(app, 'png');
	assert.equal(found.length, 1);
	assert.equal(convertNativeImageLink(found[0]), '![示意图](<image.png>)');
});

test('skips dimensions and unresolved targets', () => {
	assert.equal(convertNativeImageLink(link('![[image.png|300x200]]', 'image.png', 0, { reason: '包含尺寸参数' })), null);
	assert.equal(convertNativeImageLink(link('![[missing.png]]', 'missing.png', 0, { file: undefined })), null);
});

// Idempotency: after conversion the embed is Markdown syntax, so a rescan must
// not offer it as a native wiki embed again.
test('markdown images produced by conversion are not native candidates again', () => {
	const cache = {
		embeds: [
			{ original: '![[a.png]]', link: 'a.png', position: { start: { offset: 0 }, end: { offset: 10 } } },
			{ original: '![](<a.png>)', link: 'a.png', position: { start: { offset: 20 }, end: { offset: 31 } } },
		],
	};
	const app = {
		vault: { getMarkdownFiles: () => [{ path: 'note.md' }] },
		metadataCache: {
			getFileCache: () => cache,
			getFirstLinkpathDest: () => ({ path: 'a.png' }),
		},
	};
	const found = findNativeImageLinks(app, 'png');
	assert.equal(found.length, 1);
	assert.equal(found[0].original, '![[a.png]]');
});

// The cache can lag behind the write. Replaying the pre-conversion embed
// against the new content must not rewrite a different identical embed.
test('replaying a stale cache after native conversion is a no-op', () => {
	const content = '前 ![[a.png]] 后 ![[a.png]]';
	const firstStart = content.indexOf('![[a.png]]');
	const secondStart = content.indexOf('![[a.png]]', firstStart + 1);
	const first = replaceNativeImageLinks(content, [link('![[a.png]]', 'a.png', firstStart)]);
	assert.equal(first.converted, 1);
	const replay = replaceNativeImageLinks(first.content, [link('![[a.png]]', 'a.png', firstStart)]);
	assert.equal(replay.converted, 0);
	assert.equal(replay.skipped, 1);
	assert.equal(replay.content, first.content);
	const shifted = replaceNativeImageLinks(first.content, [link('![[a.png]]', 'a.png', secondStart)]);
	assert.equal(shifted.converted, 0, '旧偏移不能误改后面尚未转换的嵌入');
	assert.equal(shifted.content, first.content);
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
	assert.equal(convertNativeImageLink(alias[0]), '![示意图](<image.png>)');
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
	assert.equal(convertNativeImageLink(numericAlias[0]), '![2024版](<image.png>)');
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

// The cached offset can be stale after an edit. A unique fallback is safe, but
// repeated identical embeds must not be guessed or the wrong image is changed.
test('nativeImageLinkOffset only falls back to a unique occurrence', () => {
	const single = 'prefix ![[a.png]] suffix';
	const at = single.indexOf('![[a.png]]');
	assert.deepEqual(
		nativeImageLinkOffset(single, link('![[a.png]]', 'a.png', 999)),
		{ start: at, end: at + '![[a.png]]'.length },
	);
	const repeated = '![[a.png]] and ![[a.png]]';
	assert.equal(nativeImageLinkOffset(repeated, link('![[a.png]]', 'a.png', 999)), null);
	const second = repeated.lastIndexOf('![[a.png]]');
	assert.deepEqual(
		nativeImageLinkOffset(repeated, link('![[a.png]]', 'a.png', second)),
		{ start: second, end: second + '![[a.png]]'.length },
	);
});

test('does not replace a different identical embed when the cached position is stale', () => {
	const second = link('![[a.png]]', 'a.png', 11);
	assert.deepEqual(replaceNativeImageLinks('![[a.png]]\nchanged', [second]), { content: '![[a.png]]\nchanged', converted: 0, skipped: 1 });
});

test('converts a range that is cached twice only once', () => {
	const first = link('![[a.png]]', 'a.png', 0);
	const duplicate = { ...first, position: { start: { offset: 0 }, end: { offset: first.original.length } } };
	assert.deepEqual(replaceNativeImageLinks('![[a.png]]', [first, duplicate]), { content: '![](<a.png>)', converted: 1, skipped: 1 });
});

test('skips a cached range that runs past the end of the note', () => {
	const beyond = { ...link('![[a.png]]', 'a.png', 0), position: { start: { offset: 0 }, end: { offset: 99 } } };
	assert.deepEqual(replaceNativeImageLinks('![[a.png]]', [beyond]), { content: '![[a.png]]', converted: 0, skipped: 1 });
});

test('converts every link in a 5MB note with 5000 native links', () => {
	const count = 5000;
	const filler = 'x'.repeat(Math.floor((5 * 1024 * 1024) / count));
	const parts = [];
	const links = [];
	let offset = 0;
	for (let i = 0; i < count; i++) {
		const fillerLine = `${filler}\n`;
		parts.push(fillerLine);
		offset += fillerLine.length;
		const original = `![[img-${i}.png]]`;
		links.push(link(original, `img-${i}.png`, offset));
		parts.push(original, '\n');
		offset += original.length + 1;
	}
	const content = parts.join('');
	const started = performance.now();
	const result = replaceNativeImageLinks(content, links);
	const elapsed = performance.now() - started;
	assert.deepEqual({ converted: result.converted, skipped: result.skipped }, { converted: count, skipped: 0 });
	assert.equal(result.content, parts.map((part) => (part.startsWith('![[') ? `![](<${part.slice(3, -2)}>)` : part)).join(''));
	assert.ok(elapsed < 2000, `conversion took ${Math.round(elapsed)}ms`);
});
