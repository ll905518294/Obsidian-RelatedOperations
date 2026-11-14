export type CleanupRisk = 'safe' | 'confirm' | 'info';
export type CleanupTab = 'overview' | 'images' | 'attachments' | 'broken-links' | 'native-links' | 'broken-note-links' | 'empty-files' | 'folders' | 'duplicates';

export function riskForCleanupTab(tab: CleanupTab): CleanupRisk {
	if (tab === 'images' || tab === 'attachments' || tab === 'empty-files' || tab === 'folders') return 'safe';
	if (tab === 'broken-links' || tab === 'native-links' || tab === 'broken-note-links' || tab === 'duplicates') return 'confirm';
	return 'info';
}

export function cleanupRiskLabel(risk: CleanupRisk): string {
	return risk === 'safe' ? '安全处理' : risk === 'confirm' ? '需确认' : '仅提示';
}
