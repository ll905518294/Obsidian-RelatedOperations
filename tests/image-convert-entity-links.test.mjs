import test from 'node:test';
import assert from 'node:assert/strict';
import {
	findRawImageReferenceSources,
	hasRawImageReference,
} from '../src/image-convert/image-convert-links.ts';

test('HTML 实体编码的图片引用仍被视为原文引用', () => {
	const content = '&lt;img src="a&amp;#46;png"&gt;';
	assert.equal(hasRawImageReference(content, 'a.png'), true);
});

test('无分号与多层转义的实体编码也能识别', () => {
	assert.equal(hasRawImageReference('a&#46png', 'a.png'), true);
	assert.equal(hasRawImageReference('a&amp;amp;#46;png', 'a.png'), true);
	assert.equal(hasRawImageReference('&lt;img src=&quot;a.png&quot;&gt;', 'a.png'), true);
});

test('带实体编码引用的笔记会被原文兜底拦截', async () => {
	const content = '&lt;img src="a&amp;#46;png"&gt;';
	const app = {
		vault: {
			getFiles: () => [{ path: 'note.md', extension: 'md' }],
			read: async () => content,
		},
	};
	assert.deepEqual(await findRawImageReferenceSources(app, 'a.png'), ['note.md']);
});
