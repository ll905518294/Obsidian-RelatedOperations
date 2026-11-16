export type ImageConvertTarget = 'jpg' | 'webp' | 'png';
export type ImageSourceFormat = 'png' | 'jpg' | 'webp' | 'bmp' | 'avif';

export const SOURCE_IMAGE_FORMATS: readonly ImageSourceFormat[] = ['png', 'jpg', 'webp', 'bmp', 'avif'];
export const TARGET_IMAGE_FORMATS: readonly ImageConvertTarget[] = ['jpg', 'webp', 'png'];

const SOURCE_EXTENSIONS = new Set<string>(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif']);

export interface ImageConvertCandidate {
	path: string;
	size: number;
	projectedBytes?: number;
}

export interface ImageConvertPlanItem {
	path: string;
	size: number;
	projectedBytes: number;
	targetPath: string;
}

export interface ImageConvertSummary {
	count: number;
	totalBytes: number;
	projectedBytes: number;
	savedBytes: number;
	savingPercent: number;
}

export interface ImageConvertPlanOptions {
	targetExists?: (path: string) => boolean;
	existingPaths?: Iterable<string>;
	caseSensitive?: boolean;
	projectBytes?: (file: ImageConvertCandidate) => number | undefined;
}

export interface ImageConvertPlan {
	target: ImageConvertTarget;
	items: ImageConvertPlanItem[];
	skipped: Array<{ path: string; reason: string; reasonText: string }>;
	summary: ImageConvertSummary;
}

export function normalizeImageExtension(extension: string): string {
	const value = extension.trim().replace(/^\./, '').toLowerCase();
	return value === 'jpeg' ? 'jpg' : value;
}

export function sourceImageFormat(path: string): ImageSourceFormat | null {
	const extension = normalizeImageExtension(fileExtension(path));
	return SOURCE_EXTENSIONS.has(extension) && extension !== 'jpeg' ? extension as ImageSourceFormat : null;
}

export function isConvertibleImage(path: string): boolean {
	return sourceImageFormat(path) !== null;
}

export function targetPathFor(path: string, target: ImageConvertTarget): string {
	const normalized = path.replace(/\\/g, '/');
	const slash = normalized.lastIndexOf('/');
	const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	return `${slash >= 0 ? normalized.slice(0, slash + 1) : ''}${stem}.${target}`;
}

export function summarizeImageConversions(items: Iterable<Pick<ImageConvertPlanItem, 'size' | 'projectedBytes'>>): ImageConvertSummary {
	let count = 0;
	let totalBytes = 0;
	let projectedBytes = 0;
	for (const item of items) {
		count++;
		totalBytes += item.size;
		projectedBytes += item.projectedBytes;
	}
	const savedBytes = totalBytes - projectedBytes;
	const savingPercent = totalBytes > 0 ? Math.round((savedBytes / totalBytes) * 1000) / 10 : 0;
	return { count, totalBytes, projectedBytes, savedBytes, savingPercent };
}

export function planImageConversions(
	files: Iterable<ImageConvertCandidate>,
	target: ImageConvertTarget,
	options: ImageConvertPlanOptions = {},
): ImageConvertPlan {
	const items: ImageConvertPlanItem[] = [];
	const skipped: Array<{ path: string; reason: string; reasonText: string }> = [];
	const seen = new Set<string>();
	const caseSensitive = options.caseSensitive ?? false;
	const existing = new Set<string>();
	for (const path of options.existingPaths ?? []) existing.add(pathKey(path, caseSensitive));
	const targetExists = (path: string) => options.targetExists?.(path) === true || existing.has(pathKey(path, caseSensitive));
	for (const file of files) {
		if (seen.has(file.path)) continue;
		seen.add(file.path);
		const format = sourceImageFormat(file.path);
		if (!format) continue;
		if (format === target) continue;
		const targetPath = targetPathFor(file.path, target);
		if (targetExists(targetPath)) {
			skipped.push({ path: file.path, reason: 'target-exists', reasonText: '目标文件已存在' });
			continue;
		}
		const projected = options.projectBytes?.(file) ?? file.projectedBytes;
		items.push({
			path: file.path,
			size: file.size,
			projectedBytes: Math.max(0, projected ?? file.size),
			targetPath,
		});
	}
	const byTarget = new Map<string, ImageConvertPlanItem[]>();
	for (const item of items) {
		const key = pathKey(item.targetPath, caseSensitive);
		const group = byTarget.get(key) ?? [];
		group.push(item);
		byTarget.set(key, group);
	}
	const colliding = new Set<string>();
	for (const group of byTarget.values()) {
		if (group.length < 2) continue;
		for (const item of group) colliding.add(item.path);
	}
	for (const item of items) {
		if (!colliding.has(item.path)) continue;
		skipped.push({
			path: item.path,
			reason: 'target-collision',
			reasonText: '多张图片会转换为同一目标文件',
		});
	}
	const accepted = items.filter((item) => !colliding.has(item.path));
	return {
		target,
		items: accepted,
		skipped,
		summary: summarizeImageConversions(accepted),
	};
}

export function pathKey(path: string, caseSensitive = false): string {
	const normalized = path.replace(/\\/g, '/');
	return caseSensitive ? normalized : normalized.toLowerCase();
}

function fileExtension(path: string): string {
	const normalized = path.replace(/\\/g, '/');
	const name = normalized.slice(normalized.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot >= 0 ? name.slice(dot + 1) : '';
}
