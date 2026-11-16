import { isCaseSensitiveFileSystem } from '../core-utils.ts';
import type { PathStyle, ReferenceSpan, RewriteKind } from './image-reference-types.ts';

const EXTERNAL_LINK_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function createMatcher(
	oldPath: string,
	newPath: string,
	sourcePath: string,
	caseSensitive: boolean,
	resolveLink: ((linkPath: string) => string | null) | undefined,
	vaultPaths: string[] | undefined,
	kind: RewriteKind,
): { render(rawTarget: string, allowBareName: boolean): string | null } {
	return {
		render(rawTarget: string, allowBareName: boolean): string | null {
			const parsed = parseRawTarget(rawTarget);
			if (!parsed) return null;
			const style = resolvePathStyle(parsed.path, oldPath, sourcePath, allowBareName, resolveLink, vaultPaths, caseSensitive);
			if (!style) return null;
			let rendered = kind === 'canvas'
				? newPath.replace(/\\/g, '/')
				: relativePath(dirname(sourcePath), newPath);
			if (/%[0-9a-f]{2}/i.test(parsed.path)) {
				const escapes = [...parsed.path.matchAll(/%([0-9a-f]{2})/gi)].map((match) => match[1]!.toLowerCase());
				rendered = escapes.some((escape) => escape !== '20')
					? encodeURI(rendered)
					: rendered.replace(/ /g, '%20');
			}
			rendered += parsed.suffix;
			return parsed.bracketed ? `<${rendered}>` : rendered;
		},
	};
}

export function resolvePathStyle(
	rawTarget: string,
	oldPath: string,
	sourcePath: string,
	allowBareName: boolean,
	resolveLink: ((linkPath: string) => string | null) | undefined,
	_vaultPaths: string[] | undefined,
	caseSensitive: boolean,
): PathStyle | null {
	const parsed = parseRawTarget(rawTarget);
	if (!parsed) return null;
	const decoded = safeDecode(parsed.path).replace(/\\/g, '/');
	if (!decoded || EXTERNAL_LINK_PATTERN.test(decoded)) return null;
	const leadingSlash = decoded.startsWith('/');
	const bare = !decoded.includes('/');
	const vaultPath = decoded.replace(/^\/+/, '');

	if (resolveLink) {
		let resolvedAny = false;
		for (const candidate of [parsed.path, decoded]) {
			try {
				const resolved = resolveLink(candidate);
				if (!resolved) continue;
				resolvedAny = true;
				if (samePath(resolved, oldPath, caseSensitive)) {
					if (leadingSlash) return 'absolute';
					if (/^\.{1,2}\//.test(decoded)) return 'relative';
					if (bare && allowBareName) return 'basename';
					if (samePath(vaultPath, oldPath, caseSensitive)) return 'vault';
					return sourcePath ? 'relative' : 'vault';
				}
			} catch {
				// A resolver that throws is treated as unresolved; the textual
				// fallback below still handles unambiguous vault paths.
			}
		}
		// Obsidian's resolver is authoritative when it knows the link. Falling
		// back to a basename match here would rewrite a same-named file in a
		// different folder.
		if (resolvedAny) return null;
	}
	if (samePath(vaultPath, oldPath, caseSensitive)) return leadingSlash ? 'absolute' : 'vault';
	if (sourcePath && samePath(resolveRelative(sourcePath, decoded), oldPath, caseSensitive)) return 'relative';
	const oldStem = stripExtension(oldPath);
	if (extensionOf(decoded) === '') {
		if (samePath(vaultPath, oldStem, caseSensitive)) return leadingSlash ? 'absolute' : 'vault';
		if (sourcePath && samePath(resolveRelative(sourcePath, decoded), oldStem, caseSensitive)) return 'relative';
	}
	if (allowBareName && bare && basenameMatches(decoded, oldPath, caseSensitive)) return 'basename';
	return null;
}

export function wikiBodyReplacement(span: ReferenceSpan, newPath: string, sourcePath: string): string {
	const suffix = splitSubpath(span.rawTarget).suffix;
	const destination = `<${relativePath(dirname(sourcePath), newPath)}${suffix}>`;
	const wiki = span.wiki;
	if (!wiki) return destination;
	const text = wiki.bang ? wiki.alias : (wiki.alias || wiki.originalTarget);
	return `${wiki.bang ? '!' : ''}[${text}](${destination})`;
}

export function parseRawTarget(rawTarget: string): { bracketed: boolean; path: string; suffix: string } | null {
	let value = rawTarget.trim();
	if (!value) return null;
	let bracketed = false;
	if (value.startsWith('<') && value.endsWith('>')) {
		bracketed = true;
		value = value.slice(1, -1).trim();
	}
	const { path, suffix } = splitSubpath(value);
	if (!path) return null;
	return { bracketed, path, suffix };
}

export function splitSubpath(value: string): { path: string; suffix: string } {
	const hash = value.indexOf('#');
	const query = value.indexOf('?');
	const indexes = [hash, query].filter((index) => index >= 0).sort((left, right) => left - right);
	const index = indexes[0];
	return index === undefined ? { path: value, suffix: '' } : { path: value.slice(0, index), suffix: value.slice(index) };
}

export function wikiTarget(match: RegExpMatchArray): string {
	const inner = match[2] ?? '';
	const pipe = inner.indexOf('|');
	return (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
}

export function markdownTargetOffset(match: string): number {
	const closeBracket = match.indexOf('](');
	let index = closeBracket >= 0 ? closeBracket + 2 : 0;
	while (index < match.length && /\s/.test(match[index]!)) index++;
	return index;
}

export function sourceKind(path: string): 'markdown' | 'canvas' | null {
	const extension = extensionOf(path);
	if (extension === 'md') return 'markdown';
	if (extension === 'canvas') return 'canvas';
	return null;
}

export function samePath(left: string, right: string, caseSensitive: boolean): boolean {
	const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\/+/, '');
	const normalizedLeft = normalize(left);
	const normalizedRight = normalize(right);
	return caseSensitive ? normalizedLeft === normalizedRight : normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

function basenameMatches(candidate: string, oldPath: string, caseSensitive: boolean): boolean {
	const candidateName = basename(candidate);
	if (extensionOf(candidate) === '') return samePath(stripExtension(candidateName), stripExtension(basename(oldPath)), caseSensitive);
	return samePath(candidateName, basename(oldPath), caseSensitive);
}

function resolveRelative(sourcePath: string, target: string): string {
	const normalized = target.replace(/\\/g, '/');
	if (normalized.startsWith('/')) return normalized.replace(/^\/+/, '');
	const segments = (dirname(sourcePath) ? dirname(sourcePath).split('/') : []).concat(normalized.split('/'));
	const resolved: string[] = [];
	for (const segment of segments) {
		if (!segment || segment === '.') continue;
		if (segment === '..') resolved.pop();
		else resolved.push(segment);
	}
	return resolved.join('/');
}

export function relativePath(fromDirectory: string, target: string): string {
	const from = fromDirectory ? fromDirectory.split('/').filter(Boolean) : [];
	const to = target.split('/').filter(Boolean);
	let common = 0;
	while (common < from.length && common < to.length && from[common] === to[common]) common++;
	const up = Array.from({ length: from.length - common }, () => '..');
	return up.concat(to.slice(common)).join('/') || basename(target);
}

export function dirname(path: string): string {
	const index = path.lastIndexOf('/');
	return index >= 0 ? path.slice(0, index) : '';
}

export function basename(path: string): string {
	const index = path.lastIndexOf('/');
	return index >= 0 ? path.slice(index + 1) : path;
}

export function stripExtension(path: string): string {
	const name = basename(path);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

export function extensionOf(path: string): string {
	const name = basename(path);
	const dot = name.lastIndexOf('.');
	return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isSizePart(part: string): boolean {
	return /^\d+(?=\s|$)/.test(part) || /\d+x\d+/i.test(part);
}

export function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export function rawReferenceVariants(oldPath: string, caseSensitive: boolean): string[] {
	const variants = new Set<string>();
	const add = (value: string) => {
		const trimmed = value.trim();
		if (trimmed) variants.add(caseSensitive ? trimmed : trimmed.toLowerCase());
	};
	const normalized = oldPath.replace(/\\/g, '/');
	for (const path of [normalized, safeDecode(normalized)]) {
		const encoded = encodeURI(path);
		const component = encodeURIComponent(path);
		add(path);
		add(encoded);
		add(component);
		add(encoded.replace(/%2F/gi, '%2F'));
		add(encoded.replace(/%2F/gi, '%2f'));
		add(component.replace(/%2F/gi, '%2f'));
	}
	for (const name of [basename(normalized), safeDecode(basename(normalized))]) {
		add(name);
		add(encodeURI(name));
		add(encodeURIComponent(name));
	}
	return [...variants];
}

export function hasRawImageReference(
	content: string,
	oldPath: string,
	caseSensitive = isCaseSensitiveFileSystem(),
): boolean {
	const normalized = content.replace(/\r\n?/g, '\n');
	// 笔记可能把 `<img>` 引用写成 HTML 实体（含多层转义，如 `&amp;#46;`），
	// 主解析器看不到标签时，原文兜底必须仍能认出它；否则源图会被移入
	// 回收站而笔记静默断链。这里只解码用于比对，不改写原文。
	const decoded = normalized.includes('&') ? decodeHtmlEntities(normalized) : normalized;
	const haystacks = decoded === normalized ? [normalized] : [normalized, decoded];
	const variants = rawReferenceVariants(oldPath, caseSensitive);
	return haystacks.some((text) => {
		const haystack = caseSensitive ? text : text.toLowerCase();
		return variants.some((variant) => haystack.includes(variant));
	});
}

const HTML_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: '\u00a0',
};

function decodeHtmlEntitiesOnce(value: string): string {
	return value.replace(
		/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g,
		(match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
			const code = decimal !== undefined ? Number(decimal) : hex !== undefined ? Number.parseInt(hex, 16) : NaN;
			if (Number.isInteger(code)) {
				return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
			}
			return HTML_ENTITIES[name!.toLowerCase()] ?? match;
		},
	);
}

/*
 * 实体可以嵌套转义（`&amp;#46;` → `&#46;` → `.`）；最多解开 4 层，
 * 既覆盖常见写法，也让异常输入的处理保持有界。
 */
function decodeHtmlEntities(value: string): string {
	let current = value;
	for (let round = 0; round < 4; round++) {
		const next = decodeHtmlEntitiesOnce(current);
		if (next === current) return current;
		current = next;
	}
	return current;
}

export function resolvedPathWithoutLeadingSlash(path: string): string {
	return safeDecode(path).replace(/\\/g, '/').replace(/^\/+/, '').split('#', 1)[0] ?? '';
}

export function insideRanges(offset: number, ranges: { start: number; end: number }[]): boolean {
	for (const range of ranges) {
		if (offset < range.start) return false;
		if (offset < range.end) return true;
	}
	return false;
}

export function overlaps(start: number, end: number, ranges: { start: number; end: number }[]): boolean {
	return ranges.some((range) => start < range.end && end > range.start);
}

export function mergeRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
	const merged: { start: number; end: number }[] = [];
	for (const range of ranges) {
		const previous = merged.at(-1);
		if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}

export function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : '未知错误';
}
