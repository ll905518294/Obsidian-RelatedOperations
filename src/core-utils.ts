export function joinVaultPath(base: string, sub: string): string {
	return [base.replace(/^\/+|\/+$/g, ''), sub.replace(/^\/+|\/+$/g, '')]
		.filter(Boolean)
		.join('/');
}

export function hasHiddenPathSegment(path: string): boolean {
	return path.split('/').some((segment) => segment.startsWith('.'));
}

// Matches sequences that look like "name.ext" or "folder/name with spaces.ext".
// Used for conservative textual reference detection: any mention counts.
const PATH_LIKE_TOKEN_PATTERN = /[\p{L}\p{N}_\-./\\][\p{L}\p{N}_\-. /\\]*\.[a-z0-9]+/giu;

const PLAIN_PATH_BASENAME_PATTERN = /^[\p{L}\p{N}_\-. /\\]+\.[a-z0-9]+$/iu;

export function pathLikeTokens(content: string): string[] {
	const tokens: string[] = [];
	for (const match of content.matchAll(PATH_LIKE_TOKEN_PATTERN)) {
		tokens.push(match[0].toLowerCase());
	}
	return tokens;
}

// Greedy matching can merge prose prefixes into a token ("see note.png").
// Space-split suffixes recover the actual file name for conservative lookups.
export function pathTokenCandidates(token: string): string[] {
	const parts = token.split(' ');
	const candidates: string[] = [];
	for (let start = 0; start < parts.length; start++) {
		const candidate = parts.slice(start).join(' ');
		if (candidate) candidates.push(candidate);
	}
	return candidates;
}

// Basenames outside the token alphabet (e.g. containing parentheses) cannot be
// found by token matching and need a direct case-insensitive text search.
export function needsRawTextSearch(basename: string): boolean {
	return !PLAIN_PATH_BASENAME_PATTERN.test(basename.toLowerCase());
}

export function parseExtensions(value: string) {
	return new Set(
		value
			.split(/[,，\s]+/)
			.map((extension) => extension.trim().replace(/^\./, '').toLowerCase())
			.filter((extension) => /^[a-z0-9]+$/.test(extension)),
	);
}

export function normalizeSettings<T extends object>(
	defaults: T,
	raw: unknown,
	validators: Partial<Record<keyof T, (value: unknown) => boolean>> = {},
): T {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...defaults };
	const persisted = raw as Record<string, unknown>;
	const result = { ...defaults };
	const defaultValues = defaults as Record<string, unknown>;
	for (const key of Object.keys(defaultValues)) {
		const validator = validators[key as keyof T];
		if (typeof persisted[key] === typeof defaultValues[key] && (!validator || validator(persisted[key]))) {
			(result as Record<string, unknown>)[key] = persisted[key];
		}
	}
	return result;
}
