import type { ImageConvertTarget } from './image-convert-plan.ts';

export const MAX_IMAGE_PIXELS = 40_000_000;

export interface DecodedImage {
	width: number;
	height: number;
	hasAlpha: boolean;
	source: CanvasImageSource;
}

export type DecodeImageResult = { ok: true; image: DecodedImage } | { ok: false; reason: string };

export type EncodeImageResult = { ok: true; bytes: ArrayBuffer } | { ok: false; reason: string };

export interface ImageCodec {
	decode(bytes: ArrayBuffer): Promise<DecodeImageResult>;
	encode(
		image: DecodedImage,
		target: ImageConvertTarget,
		options: { quality: number; flatten: boolean },
	): Promise<EncodeImageResult>;
	/**
	 * 释放 decode 返回的 source 占用的像素内存。解码一张 4000×3000 的图会
	 * 占用约 45.8MB（宽×高×4）；不主动释放就要等 GC，两个 worker 叠加时
	 * 峰值会明显高于实际并发数。调用方保证 encode 结束后才调用。
	 */
	release?(image: DecodedImage): void;
}

export function isWithinPixelLimit(width: number, height: number): boolean {
	return width > 0 && height > 0 && width * height <= MAX_IMAGE_PIXELS;
}

export class CanvasImageCodec implements ImageCodec {
	async decode(bytes: ArrayBuffer): Promise<DecodeImageResult> {
		if (bytes.byteLength === 0) return { ok: false, reason: '图片内容为空' };
		let url = '';
		try {
			url = URL.createObjectURL(new Blob([bytes]));
			const image = new Image();
			image.src = url;
			await image.decode();
			const width = image.naturalWidth || image.width;
			const height = image.naturalHeight || image.height;
			if (!width || !height) return { ok: false, reason: '无法读取图片尺寸' };
			if (!isWithinPixelLimit(width, height)) {
				return { ok: false, reason: `图片尺寸 ${width}×${height} 超过 4000 万像素上限` };
			}
			const canvas = createEl('canvas');
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext('2d', { willReadFrequently: true });
			if (!context) return { ok: false, reason: '无法创建图片画布' };
			context.drawImage(image, 0, 0, width, height);
			const pixels = context.getImageData(0, 0, width, height).data;
			let hasAlpha = false;
			for (let index = 3; index < pixels.length; index += 4) {
				if (pixels[index]! < 255) {
					hasAlpha = true;
					break;
				}
			}
			return { ok: true, image: { width, height, hasAlpha, source: canvas } };
		} catch (error) {
			return { ok: false, reason: `无法解码图片：${reasonOf(error)}` };
		} finally {
			if (url) URL.revokeObjectURL(url);
		}
	}

	async encode(
		image: DecodedImage,
		target: ImageConvertTarget,
		options: { quality: number; flatten: boolean },
	): Promise<EncodeImageResult> {
		try {
			const canvas = createEl('canvas');
			canvas.width = image.width;
			canvas.height = image.height;
			try {
				const context = canvas.getContext('2d');
				if (!context) return { ok: false, reason: '无法创建图片画布' };
				if (options.flatten || target === 'jpg') {
					context.fillStyle = '#ffffff';
					context.fillRect(0, 0, image.width, image.height);
				}
				context.drawImage(image.source, 0, 0, image.width, image.height);
				const mime = target === 'jpg' ? 'image/jpeg' : `image/${target}`;
				const quality = Math.min(1, Math.max(0, options.quality));
				const blob = await canvasToBlob(canvas, mime, quality);
				if (!blob) return { ok: false, reason: '图片编码失败' };
				return { ok: true, bytes: await blob.arrayBuffer() };
			} finally {
				// 输出画布同样占 宽×高×4；编码结束立刻缩到 0，避免和源画布
				// 一起堆积到下一轮 GC。
				canvas.width = 0;
				canvas.height = 0;
			}
		} catch (error) {
			return { ok: false, reason: `图片编码失败：${reasonOf(error)}` };
		}
	}

	release(image: DecodedImage): void {
		const source = image.source as { close?: () => void; width?: number; height?: number } | null;
		if (!source) return;
		// ImageBitmap 必须显式 close；画布则把宽高置 0，浏览器会立即回收
		// 后备存储，不必等这个 canvas 元素被 GC。
		if (typeof source.close === 'function') {
			source.close();
			return;
		}
		if (typeof source.width === 'number' && typeof source.height === 'number') {
			source.width = 0;
			source.height = 0;
		}
	}
}

export function createCanvasImageCodec(): ImageCodec {
	return new CanvasImageCodec();
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
	return new Promise((resolve) => {
		canvas.toBlob(resolve, mime, quality);
	});
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : '未知错误';
}
