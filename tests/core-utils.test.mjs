import test from 'node:test';
import assert from 'node:assert/strict';
import { joinVaultPath, normalizeSettings } from '../src/core-utils.ts';

test('joins a root target without introducing a leading slash', () => {
	assert.equal(joinVaultPath('', 'Pages'), 'Pages');
});

test('keeps only persisted settings with the expected primitive type', () => {
	const defaults = { enabled: false, autoUpdate: true, orphanImageExtensions: 'png' };
	assert.deepEqual(normalizeSettings(defaults, { enabled: true, autoUpdate: 'yes', orphanImageExtensions: 1 }), {
		enabled: true,
		autoUpdate: true,
		orphanImageExtensions: 'png',
	});
});

test('falls back when a validated setting is invalid', () => {
	const defaults = { incomingProperty: 'in', outgoingProperty: 'out' };
	const valid = (value) => typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value);
	assert.deepEqual(normalizeSettings(defaults, { incomingProperty: 'bad\nname', outgoingProperty: 'ok' }, { incomingProperty: valid }), {
		incomingProperty: 'in',
		outgoingProperty: 'ok',
	});
});
