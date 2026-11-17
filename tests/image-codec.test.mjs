import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasImageCodec } from '../src/image-convert/image-codec.ts';

function installDomStub({ imageBitmap = false, imageBitmapError = null, alpha = false, dims = { width: 10, height: 20 } } = {}) {
	const previous = {
		createEl: globalThis.createEl,
		Image: globalThis.Image,
		createImageBitmap: globalThis.createImageBitmap,
		createObjectURL: URL.createObjectURL,
		revokeObjectURL: URL.revokeObjectURL,
	};
	const createdCanvases = [];
	const revoked = [];
	const getImageDataCalls = [];
	let imageBitmapCreateCalls = 0;
	let imageDecodeCalls = 0;

	class FakeImage {
		naturalWidth = dims.width;
		naturalHeight = dims.height;

		async decode() {
			imageDecodeCalls += 1;
		}
	}

	class FakeImageBitmap {
		width = dims.width;
		height = dims.height;
		closed = 0;
		close() {
			this.closed += 1;
		}
	}

	class FakeCanvas {
		width = 0;
		height = 0;
		drawImageCalls = [];
		fillRects = [];
		toBlobArgs = null;

		getContext() {
			this._context ??= {
				fillStyle: '',
				drawImage: (source) => {
					this.drawImageCalls.push(source);
				},
				fillRect: (x, y, width, height) => {
					this.fillRects.push({ fillStyle: this._context.fillStyle, x, y, width, height });
				},
				getImageData: (x, y, width, height) => {
					getImageDataCalls.push({ x, y, width, height });
					const data = new Uint8ClampedArray(width * height * 4).fill(255);
					if (alpha) {
						for (let i = 3; i < data.length; i += 4) data[i] = 0;
					}
					return { data };
				},
			};
			return this._context;
		}

		get context() {
			return this.getContext();
		}

		toBlob(callback, mime, quality) {
			this.toBlobArgs = { mime, quality };
			callback(new Blob([new Uint8Array([1, 2, 3])]));
		}
	}

	globalThis.createEl = (name) => {
		assert.equal(name, 'canvas');
		const canvas = new FakeCanvas();
		createdCanvases.push(canvas);
		return canvas;
	};
	globalThis.Image = FakeImage;
	if (imageBitmap) {
		globalThis.createImageBitmap = async () => {
			imageBitmapCreateCalls += 1;
			if (imageBitmapError) throw imageBitmapError;
			return new FakeImageBitmap();
		};
	} else {
		delete globalThis.createImageBitmap;
	}
	URL.createObjectURL = () => 'blob:test-image';
	URL.revokeObjectURL = (url) => {
		revoked.push(url);
	};

	return {
		createdCanvases,
		revoked,
		getImageDataCalls,
		get imageBitmapCreateCalls() { return imageBitmapCreateCalls; },
		get imageDecodeCalls() { return imageDecodeCalls; },
		restore() {
			globalThis.createEl = previous.createEl;
			globalThis.Image = previous.Image;
			if (previous.createImageBitmap === undefined) delete globalThis.createImageBitmap;
			else globalThis.createImageBitmap = previous.createImageBitmap;
			URL.createObjectURL = previous.createObjectURL;
			URL.revokeObjectURL = previous.revokeObjectURL;
		},
	};
}

const bytes = () => new Uint8Array([1]).buffer;

test('needAlpha=false 完全不触发 getImageData，也不创建采样画布', async (t) => {
	const dom = installDomStub();
	t.after(() => dom.restore());
	const decoded = await new CanvasImageCodec().decode(bytes(), { needAlpha: false });
	assert.equal(decoded.ok, true);
	assert.deepEqual(dom.getImageDataCalls, [], 'flatten 路径不应读取任何像素');
	assert.equal(decoded.image.hasAlpha, false);
	assert.equal(dom.createdCanvases.length, 0, 'needAlpha=false 连画布都不必建');
});

test('needAlpha=true 用采样读取 alpha，且读取区域远小于整张图', async (t) => {
	const dom = installDomStub({ alpha: true, dims: { width: 4000, height: 3000 } });
	t.after(() => dom.restore());
	const decoded = await new CanvasImageCodec().decode(bytes(), { needAlpha: true });
	assert.equal(decoded.ok, true);
	assert.equal(decoded.image.hasAlpha, true, '透明图应被识别');
	assert.ok(dom.getImageDataCalls.length > 0, 'needAlpha 时至少读一次采样');
	for (const call of dom.getImageDataCalls) {
		assert.ok(call.width * call.height < 4000 * 3000, '单次采样区域应小于原图全像素');
	}
});

test('needAlpha=true 全不透明图 hasAlpha=false', async (t) => {
	const dom = installDomStub();
	t.after(() => dom.restore());
	const decoded = await new CanvasImageCodec().decode(bytes(), { needAlpha: true });
	assert.equal(decoded.ok, true);
	assert.equal(decoded.image.hasAlpha, false);
});

test('默认不传 options 仍检测 alpha，兼容尚未传 needAlpha 的调用方', async (t) => {
	const dom = installDomStub({ alpha: true });
	t.after(() => dom.restore());
	const decoded = await new CanvasImageCodec().decode(bytes());
	assert.equal(decoded.ok, true);
	assert.equal(decoded.image.hasAlpha, true, '默认路径必须识别透明图，skip 模式才不会误转');
});

test('支持 createImageBitmap 时优先用它解码，不创建 object URL', async (t) => {
	const dom = installDomStub({ imageBitmap: true });
	t.after(() => dom.restore());
	const codec = new CanvasImageCodec();
	const decoded = await codec.decode(bytes(), { needAlpha: false });
	assert.equal(decoded.ok, true);
	assert.equal(dom.imageBitmapCreateCalls, 1, '应调用 createImageBitmap');
	assert.equal(dom.imageDecodeCalls, 0, '不应走 Image.decode 回退');
	assert.deepEqual(dom.revoked, [], 'createImageBitmap 路径无需 object URL');
	const encoded = await codec.encode(decoded.image, 'webp', { quality: 0.8, flatten: false });
	assert.equal(encoded.ok, true);
	assert.equal(dom.createdCanvases.at(-1).drawImageCalls[0], decoded.image.source);
});

test('createImageBitmap 抛错时回退到 Image 路径并撤销 object URL', async (t) => {
	const dom = installDomStub({ imageBitmap: true, imageBitmapError: new Error('bitmap 不可用') });
	t.after(() => dom.restore());
	const decoded = await new CanvasImageCodec().decode(bytes(), { needAlpha: false });
	assert.equal(decoded.ok, true);
	assert.equal(dom.imageBitmapCreateCalls, 1);
	assert.equal(dom.imageDecodeCalls, 1, '回退路径应调用 Image.decode');
	assert.deepEqual(dom.revoked, ['blob:test-image'], '回退路径结束应撤销 object URL');
});

test('release：ImageBitmap 走 close，画布源清空宽高', async (t) => {
	const dom = installDomStub({ imageBitmap: true });
	t.after(() => dom.restore());
	const codec = new CanvasImageCodec();
	const decodedBitmap = await codec.decode(bytes(), { needAlpha: false });
	assert.equal(decodedBitmap.ok, true);
	const bitmap = decodedBitmap.image.source;
	codec.release(decodedBitmap.image);
	assert.equal(bitmap.closed, 1);
	// 画布类源（宽高为数字）走清空宽高分支。
	const canvasLike = { width: 10, height: 20 };
	codec.release({ width: 10, height: 20, hasAlpha: false, source: canvasLike });
	assert.equal(canvasLike.width, 0);
	assert.equal(canvasLike.height, 0);
});

test('空字节与超大图按原样拒绝，且不读取像素', async (t) => {
	const dom = installDomStub();
	t.after(() => dom.restore());
	const codec = new CanvasImageCodec();
	assert.deepEqual(await codec.decode(new ArrayBuffer(0), { needAlpha: true }), { ok: false, reason: '图片内容为空' });
	globalThis.Image = class {
		naturalWidth = 10000;
		naturalHeight = 5000;
		async decode() {}
	};
	const big = await codec.decode(bytes(), { needAlpha: true });
	assert.equal(big.ok, false);
	assert.match(big.reason, /超过 4000 万像素上限/);
	assert.deepEqual(dom.getImageDataCalls, [], '超大图在读像素前被拒绝');
});

test('ImageBitmap 路径的超大图在拒绝前关闭 bitmap，不泄漏像素内存', async (t) => {
	let closed = 0;
	const previous = globalThis.createImageBitmap;
	globalThis.createImageBitmap = async () => ({
		width: 10000,
		height: 5000,
		close() { closed += 1; },
	});
	t.after(() => { globalThis.createImageBitmap = previous; });
	const result = await new CanvasImageCodec().decode(bytes(), { needAlpha: true });
	assert.equal(result.ok, false);
	assert.match(result.reason, /超过 4000 万像素上限/);
	assert.equal(closed, 1, '提前返回前必须 close ImageBitmap');
});

test('decode 抛错时返回失败原因并撤销 object URL', async (t) => {
	const dom = installDomStub();
	t.after(() => dom.restore());
	globalThis.Image = class {
		async decode() { throw new Error('解码崩溃'); }
	};
	const result = await new CanvasImageCodec().decode(bytes(), { needAlpha: false });
	assert.equal(result.ok, false);
	assert.match(result.reason, /解码崩溃/);
	assert.deepEqual(dom.revoked, ['blob:test-image']);
});

test('始终在编码 JPG 时铺白底，且编码结束释放输出画布', async (t) => {
	const dom = installDomStub();
	t.after(() => dom.restore());
	const codec = new CanvasImageCodec();
	const decoded = await codec.decode(bytes(), { needAlpha: false });
	const result = await codec.encode(decoded.image, 'jpg', { quality: 0.85, flatten: false });
	assert.equal(result.ok, true);
	assert.deepEqual(dom.createdCanvases[0].fillRects, [{
		fillStyle: '#ffffff',
		x: 0,
		y: 0,
		width: 10,
		height: 20,
	}]);
	assert.deepEqual(dom.createdCanvases[0].toBlobArgs, { mime: 'image/jpeg', quality: 0.85 });
	assert.equal(dom.createdCanvases[0].width, 0);
	assert.equal(dom.createdCanvases[0].height, 0);
});
