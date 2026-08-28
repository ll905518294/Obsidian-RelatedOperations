import test from 'node:test';
import assert from 'node:assert/strict';
import {
	hasHiddenPathSegment,
	joinVaultPath,
	needsRawTextSearch,
	normalizeSettings,
	parseExtensions,
	pathLikeTokens,
	pathTokenCandidates,
} from '../src/core-utils.ts';

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

test('detects hidden path segments in any position', () => {
	assert.equal(hasHiddenPathSegment('.obsidian/plugins/demo'), true);
	assert.equal(hasHiddenPathSegment('notes/.trash'), true);
	assert.equal(hasHiddenPathSegment('notes/demo.md'), false);
	assert.equal(hasHiddenPathSegment(''), false);
});

test('extracts path-like tokens including spaced names', () => {
	const content = [
		'---',
		'banner: "assets/banner photo.jpg"',
		'---',
		'<img src="images/pic.PNG">',
		'See note.png.',
	].join('\n');
	const tokens = pathLikeTokens(content);
	assert.ok(tokens.includes('assets/banner photo.jpg'));
	assert.ok(tokens.includes('images/pic.png'));
	const candidates = tokens.flatMap((token) => pathTokenCandidates(token));
	assert.ok(candidates.includes('note.png'));
});

test('parses configurable extensions without case or leading dots', () => {
	assert.deepEqual([...parseExtensions('PNG, .jpg JICO')].sort(), ['jico', 'jpg', 'png']);
});

test('recovers the file name from prose prefixes and folder paths', () => {
	const candidates = pathTokenCandidates('see note.png');
	assert.deepEqual(candidates, ['see note.png', 'note.png']);
	const folderCandidates = pathTokenCandidates('assets/my photo.png');
	assert.deepEqual(folderCandidates, ['assets/my photo.png', 'photo.png']);
	const first = folderCandidates[0];
	assert.equal(first.slice(Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\')) + 1), 'my photo.png');
});

test('flags basenames outside the token alphabet for raw text search', () => {
	assert.equal(needsRawTextSearch('photo (1).png'), true);
	assert.equal(needsRawTextSearch('封面 图.png'), false);
	assert.equal(needsRawTextSearch('cover.jpg'), false);
});
