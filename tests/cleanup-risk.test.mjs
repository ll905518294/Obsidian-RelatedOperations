import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupRiskLabel, riskForCleanupTab } from '../src/cleanup-risk.ts';

test('classifies every cleanup tab into a risk level', () => {
	assert.equal(riskForCleanupTab('images'), 'safe');
	assert.equal(riskForCleanupTab('attachments'), 'safe');
	assert.equal(riskForCleanupTab('empty-files'), 'safe');
	assert.equal(riskForCleanupTab('folders'), 'safe');
	assert.equal(riskForCleanupTab('broken-links'), 'confirm');
	assert.equal(riskForCleanupTab('native-links'), 'confirm');
	assert.equal(riskForCleanupTab('broken-note-links'), 'confirm');
	assert.equal(riskForCleanupTab('overview'), 'info');
	assert.equal(riskForCleanupTab('duplicates'), 'info');
});

test('renders a distinct Chinese label for each risk level', () => {
	assert.equal(cleanupRiskLabel('safe'), '安全处理');
	assert.equal(cleanupRiskLabel('confirm'), '需确认');
	assert.equal(cleanupRiskLabel('info'), '仅提示');
	assert.equal(new Set([cleanupRiskLabel('safe'), cleanupRiskLabel('confirm'), cleanupRiskLabel('info')]).size, 3);
});
