export function joinVaultPath(base: string, sub: string): string {
	return [base.replace(/^\/+|\/+$/g, ''), sub.replace(/^\/+|\/+$/g, '')]
		.filter(Boolean)
		.join('/');
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
