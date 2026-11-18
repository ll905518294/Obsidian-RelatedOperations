import type { CleanupViewContext } from './cleanup-types';
import { collectAutoEmptyFolders } from './cleanup-actions';
import { parseIgnoredFolders } from '../core-utils';

/*
 * 清理后状态回收（编排层）。
 *
 * 单独成模块是为了让它保持轻依赖：只依赖 cleanup-actions 与 core-utils，
 * 不牵动 cleanup-modals / cleanup-scan。被转换控制器直接引用时，不会把
 * 弹窗与扫描模块拖进调用方的依赖图。
 */

/*
 * 清理后的重扫收尾。真实 Panel 具备完整扫描能力时做一次全量重扫（保留已
 * 清理的计数）；不具备完整扫描能力的宿主（如部分测试桩）退回轻量的文件夹
 * 复查，避免因缺失扫描控制器所需成员而抛错。
 */
interface CleanupRescanCapability {
	scan?(preserveProcessed?: boolean): Promise<void>;
	scanGeneration?: number;
}

async function rescanAfterCleanup(host: CleanupViewContext): Promise<void> {
	const candidate = host as unknown as CleanupRescanCapability;
	if (typeof candidate.scan === 'function' && typeof candidate.scanGeneration === 'number') {
		try {
			// Panel 的 scan(preserveProcessed) 内部即 runFullScan(this, preserveProcessed)，
			// 传 true 与直接调用 runFullScan 等价，同时避免把扫描控制器拖进依赖图。
			// 必须带 host 作为 this：Panel 的 scan 依赖 this 指向面板实例。
			await candidate.scan.call(host, true);
			return;
		} catch {
			// 全量重扫不可用时退回轻量收尾，不能让清理结果因此丢失。
		}
	}
	await host.scanTab('folders');
	host.renderContents();
}

/*
 * 清理后状态回收：删除一批文件后，沿其父级收集“变空”的文件夹链并逐个移入
 * 回收站，然后做一次全关联重扫，让面板状态与磁盘一致。单个文件夹删除失败
 * 不阻塞其余清理。
 */
export async function finalizeCleanup(host: CleanupViewContext, deletedPaths: string[]): Promise<{ removedFolders: number }> {
	const ignored = parseIgnoredFolders(host.settings.orphanIgnoredFolders);
	const folders = await collectAutoEmptyFolders(host.app, deletedPaths, ignored);
	let removedFolders = 0;
	for (const folder of folders) {
		try {
			await host.app.fileManager.trashFile(folder);
			removedFolders += 1;
		} catch {
			// 单个文件夹移入回收站失败不影响其余清理。
		}
	}
	await rescanAfterCleanup(host);
	return { removedFolders };
}
