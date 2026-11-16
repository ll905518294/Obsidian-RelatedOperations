import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasImageCodec } from '../src/image-convert/image-codec.ts';

function installDomStub() {
	const previous = {
		document: globalThis.document,
		Image: globalThis.Image,
		createEl: globalThis.createEl,
		createObjectURL: URL.createObjectURL,
		revokeObjectURL: URL.revokeObjectURL,
	};
	const createdCanvases = [];
	const revoked = [];

	class FakeImage {
		naturalWidth = 10;
		naturalHeight = 20;

		async decode() {}
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
				getImageData: (_x, _y, width, height) => ({
					data: new Uint8ClampedArray(width * height * 4).fill(255),
				}),
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

	globalThis.document = previous.document;
	globalThis.createEl = (name) => {
		assert.equal(name, 'canvas');
		const canvas = new FakeCanvas();
		createdCanvases.push(canvas);
		return canvas;
	};
	globalThis.Image = FakeImage;
	URL.createObjectURL = () => 'blob:test-image';
	URL.revokeObjectURL = (url) => {
		revoked.push(url);
	};

	return {
		createdCanvases,
		revoked,
		restore() {
			globalThis.document = previous.document;
			globalThis.Image = previous.Image;
			globalThis.createEl = previous.createEl;
			URL.createObjectURL = previous.createObjectURL;
			URL.revokeObjectURL = previous.revokeObjectURL;
		},
	};
}

test('decodes into a canvas snapshot before revoking the object URL', async (t) => {
	const dom = installDomStub();
	t.after(() => dom.restore());
	const decoded = await new CanvasImageCodec().decode(new Uint8Array([1]).buffer);
	assert.equal(decoded.ok, true);
	assert.deepEqual(dom.revoked, ['blob:test-image']);
	assert.equal(decoded.image.source, dom.createdCanvases[0]);

	const encoded = await new CanvasImageCodec().encode(decoded.image, 'webp', {
		quality: 0.8,
		flatten: false,
	});
	assert.equal(encoded.ok, true);
	assert.equal(dom.createdCanvases[1].drawImageCalls[0], decoded.image.source);
});

test('always paints a white background when encoding JPG', async (t) => {
	const dom = installDomStub();
	t.after(() => dom.restore());
	const decoded = await new CanvasImageCodec().decode(new Uint8Array([1]).buffer);
	const result = await new CanvasImageCodec().encode(decoded.image, 'jpg', {
		quality: 0.85,
		flatten: false,
	});
	assert.equal(result.ok, true);
	assert.deepEqual(dom.createdCanvases[1].fillRects, [{
		fillStyle: '#ffffff',
		x: 0,
		y: 0,
		width: 10,
		height: 20,
	}]);
	assert.deepEqual(dom.createdCanvases[1].toBlobArgs, {
		mime: 'image/jpeg',
		quality: 0.85,
	});
});
