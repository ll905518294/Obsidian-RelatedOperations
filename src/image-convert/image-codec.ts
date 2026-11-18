import type { ImageConvertTarget } from './image-convert-plan.ts';

/**
 * 解码/编码的硬像素上限：宽×高超过该值直接跳过，防止单张图把画布与位图堆到
 * 数 GB 触发 Obsidian 内存崩溃。1.2 亿像素可覆盖 9921×7016（约 6960 万像素）
 * 这类 CAD 长图，同时仍保留防止 OOM 的硬闸。
 */
export const MAX_IMAGE_PIXELS = 120_000_000;
/**
 * 超过该像素数视为大图：解码/编码各占 宽×高×4 字节，大图进入单独的
 * 低并发通道，避免多张大图同时把画布堆到 GB 级。
 */
export const LARGE_IMAGE_PIXELS = 10_000_000;
/**
 * 解码前拿不到像素数，只能用文件体积预判。高压缩的 CAD 线稿可能像素极高
 * （如 5500 万像素）却只有约 7MB，若沿用 8MB 阈值会落进并发通道，多张大
 * 位图叠加到 GB 级。降到 4MB 让这类图也走单并发；普通截图多为 100KB–2MB，
 * 仍走并发通道，不受影响。
 */
export const LARGE_IMAGE_BYTES = 4 * 1024 * 1024;

export function isLargeImage(width: number, height: number): boolean {
	return width > 0 && height > 0 && width * height > LARGE_IMAGE_PIXELS;
}

/**
 * 串行闸门：同一时刻只放行一个任务。用于大图编码阶段，让已知像素数
 * 超过 10MP 的图排队，而不是和普通图一起并发占用输出画布。
 */
export function createSerialGate(): <T>(task: () => Promise<T>) => Promise<T> {
	let tail: Promise<void> = Promise.resolve();
	return async <T>(task: () => Promise<T>): Promise<T> => {
		const wait = tail;
		let release!: () => void;
		tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await wait;
		try {
			return await task();
		} finally {
			release();
		}
	};
}

export interface DecodedImage {
	width: number;
	height: number;
	hasAlpha: boolean;
	source: CanvasImageSource;
}

export type DecodeImageResult =
	| { ok: true; image: DecodedImage }
	| { ok: false; reason: string; reasonId?: 'pixel-limit' };

export type EncodeImageResult = { ok: true; bytes: ArrayBuffer } | { ok: false; reason: string };

export interface ImageCodec {
	decode(bytes: ArrayBuffer, options?: { needAlpha?: boolean }): Promise<DecodeImageResult>;
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

/** alpha 采样画布的边长上限：最多 64×64×4 = 16KB，而非原图数十 MB。 */
const ALPHA_SAMPLE_SIZE = 64;

export class CanvasImageCodec implements ImageCodec {
	async decode(bytes: ArrayBuffer, options?: { needAlpha?: boolean }): Promise<DecodeImageResult> {
		if (bytes.byteLength === 0) return { ok: false, reason: '图片内容为空' };
		let url = '';
		let bitmap: ImageBitmap | null = null;
		let keepBitmap = false;
		try {
			let source: CanvasImageSource;
			let width: number;
			let height: number;
			// 优先用浏览器原生 createImageBitmap 直接解码，省去 Image + 二次绘制；
			// 不可用时回退到 Image + object URL（老版本/受限环境）。
			if (typeof createImageBitmap === 'function') {
				try {
					bitmap = await createImageBitmap(new Blob([bytes]));
				} catch {
					bitmap = null;
				}
			}
			if (bitmap) {
				source = bitmap;
				width = bitmap.width;
				height = bitmap.height;
			} else {
				url = URL.createObjectURL(new Blob([bytes]));
				const image = new Image();
				image.src = url;
				await image.decode();
				source = image;
				width = image.naturalWidth || image.width;
				height = image.naturalHeight || image.height;
			}
			if (!width || !height) return { ok: false, reason: '无法读取图片尺寸' };
			if (!isWithinPixelLimit(width, height)) {
				return {
					ok: false,
					reason: `图片尺寸 ${width}×${height} 超过 1.2 亿像素上限，为避免 Obsidian 内存崩溃已跳过`,
					reasonId: 'pixel-limit',
				};
			}
			// needAlpha=false（flatten 模式）完全跳过像素读取，直接用解码结果作 source。
			// 默认（不传）仍检测，保证未传参的调用方拿到正确的 hasAlpha。
			const hasAlpha = options?.needAlpha === false ? false : hasTransparentPixel(source, width, height);
			keepBitmap = true;
			return { ok: true, image: { width, height, hasAlpha, source } };
		} catch (error) {
			return { ok: false, reason: `无法解码图片：${reasonOf(error)}` };
		} finally {
			if (url) URL.revokeObjectURL(url);
			// 只有成功返回且 source 交给调用方时才保留 bitmap；其余分支统一关闭，
			// 避免异常或前置校验失败时泄漏 ImageBitmap 的像素内存。
			if (bitmap && !keepBitmap) bitmap.close();
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
		const source = image.source as { close?: () => void; width?: number; height?: number; src?: string } | null;
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
			return;
		}
		// Image 回退路径：清空 src，提示浏览器尽早释放已解码位图。
		if (typeof source.src === 'string' && source.src) {
			source.src = '';
		}
	}
}

/**
 * 把原图等比缩到不超过 64×64 的采样画布，只读这块小区域的 alpha 通道。
 * 相比逐像素读取整图（4000×3000 = 48MB），这里最多读 16KB；缩放采样仍能
 * 识别出有实际面积分布的透明区域，透明图在 skip 模式下照样被跳过。
 */
function hasTransparentPixel(source: CanvasImageSource, width: number, height: number): boolean {
	const scale = Math.min(1, ALPHA_SAMPLE_SIZE / Math.max(width, height));
	const sampleWidth = Math.max(1, Math.round(width * scale));
	const sampleHeight = Math.max(1, Math.round(height * scale));
	const canvas = createEl('canvas');
	canvas.width = sampleWidth;
	canvas.height = sampleHeight;
	try {
		const context = canvas.getContext('2d', { willReadFrequently: true });
		if (!context) return false;
		context.drawImage(source, 0, 0, sampleWidth, sampleHeight);
		const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
		for (let index = 3; index < pixels.length; index += 4) {
			if (pixels[index]! < 255) return true;
		}
		return false;
	} finally {
		canvas.width = 0;
		canvas.height = 0;
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
