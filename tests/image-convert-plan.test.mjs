import test from 'node:test';
import assert from 'node:assert/strict';
import {
	isConvertibleImage,
	planImageConversions,
	sourceImageFormat,
	summarizeImageConversions,
	targetPathFor,
} from '../src/image-convert/image-convert-plan.ts';

test('accepts only png, jpg/jpeg, webp, bmp and avif as sources', () => {
	for (const path of ['a.png', 'a.JPG', 'a.jpeg', 'a.webp', 'a.bmp', 'a.AVIF']) {
		assert.equal(isConvertibleImage(path), true, path);
	}
	for (const path of ['a.gif', 'a.svg', 'a.tiff', 'a.tif', 'a.heic', 'a.heif', 'a.ico', 'a.psd', 'a']) {
		assert.equal(isConvertibleImage(path), false, path);
	}
	assert.equal(sourceImageFormat('a.JPEG'), 'jpg');
});

test('excludes a source that already matches the target format', () => {
	const plan = planImageConversions([
		{ path: 'a.png', size: 100 },
		{ path: 'b.jpg', size: 100 },
		{ path: 'c.jpeg', size: 100 },
	], 'jpg');
	assert.deepEqual(plan.items.map((item) => item.path), ['a.png']);
	assert.deepEqual(plan.skipped, []);
});

test('targetPathFor keeps the folder and replaces only the extension', () => {
	assert.equal(targetPathFor('a/b/c.png', 'webp'), 'a/b/c.webp');
	assert.equal(targetPathFor('a.b/c', 'jpg'), 'a.b/c.jpg');
	assert.equal(targetPathFor('C:\\vault\\a.png', 'jpg'), 'C:/vault/a.jpg');
});

test('detects target conflicts with platform-normalized paths', () => {
	const plan = planImageConversions(
		[{ path: 'A.PNG', size: 100 }],
		'webp',
		{ existingPaths: ['a.webp'], caseSensitive: false },
	);
	assert.equal(plan.items.length, 0);
	assert.deepEqual(plan.skipped, [{
		path: 'A.PNG',
		reason: 'target-exists',
		reasonText: '目标文件已存在',
	}]);
});

test('rejects every source that would convert onto the same target', () => {
	const plan = planImageConversions([
		{ path: 'a.png', size: 100 },
		{ path: 'a.bmp', size: 100 },
	], 'webp');
	assert.deepEqual(plan.items, []);
	assert.deepEqual(plan.skipped.map((item) => item.path).sort(), ['a.bmp', 'a.png']);
	for (const item of plan.skipped) {
		assert.equal(item.reason, 'target-collision');
		assert.match(item.reasonText, /同一目标文件/);
	}
});

test('summarizes negative savings for images that grow', () => {
	const summary = summarizeImageConversions([
		{ size: 100, projectedBytes: 300 },
		{ size: 100, projectedBytes: 50 },
	]);
	assert.deepEqual(summary, {
		count: 2,
		totalBytes: 200,
		projectedBytes: 350,
		savedBytes: -150,
		savingPercent: -75,
	});
});

test('summarizes an empty conversion plan without dividing by zero', () => {
	assert.deepEqual(summarizeImageConversions([]), {
		count: 0,
		totalBytes: 0,
		projectedBytes: 0,
		savedBytes: 0,
		savingPercent: 0,
	});
});
