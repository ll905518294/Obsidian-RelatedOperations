import { App, normalizePath, Notice, TFile, TFolder } from 'obsidian';
import { isVaultRelativePath } from '../core-utils';
import type { RelatedNote } from '../related-notes';
import {
	finalTarget,
	formatMoveResult,
	isAlreadyAtTarget,
	parentFolder,
	targetFolderStatus,
	type MoveFailure,
	type MoveRecord,
	type MoveResult,
} from './related-notes-model';
import { MoveConfirmationModal } from './related-notes-modals';

export interface RelatedNotesMoveHost {
	readonly app: App;
	relatedNotes(): RelatedNote[];
	selections(): Map<string, boolean>;
	targetFolder(): string;
	lastMove(): MoveRecord[];
	setLastMove(records: MoveRecord[]): void;
	updateUndoButton(): void;
	pruneMovedNotes(moved: MoveRecord[]): void;
	recomputeRelatedNotes(): void;
}

export async function moveSelected(host: RelatedNotesMoveHost) {
	const targetFolder = finalTarget(host.targetFolder());
	if (!targetFolder || !isVaultRelativePath(targetFolder)) {
		new Notice('请输入 vault 内的目标文件夹。');
		return;
	}
	const targetCheck = targetFolderStatus(host.app, targetFolder);
	if (targetCheck.state === 'blocked') {
		new Notice(`目标路径中的「${targetCheck.blocker}」是文件，无法创建文件夹；请改用其他文件夹名，或先把该文件移走。`);
		return;
	}
	const selected = [...host.selections().entries()]
		.filter(([, checked]) => checked)
		.map(([path]) => host.relatedNotes().find((note) => note.file.path === path))
		.filter((note): note is RelatedNote => note !== undefined);
	if (selected.length === 0) {
		new Notice('请至少选择一篇关联笔记。');
		return;
	}
	const selectedFiles = [...new Map(selected.map((note) => [note.file.path, note.file])).values()];
	const paths = createPathIndex(host.app);
	const conflicts = selectedFiles.filter((file) => {
		const destination = normalizePath(`${targetFolder}/${file.name}`);
		return destination.toLowerCase() !== file.path.toLowerCase() && paths.has(destination);
	});
	const movable = selectedFiles.filter((file) => !conflicts.includes(file) && !isAlreadyAtTarget(file, host.targetFolder()));
	if (movable.length === 0) {
		new Notice('所选笔记都已经在目标文件夹或存在冲突。');
		return;
	}
	const confirmed = await new MoveConfirmationModal(
		host.app,
		targetFolder,
		movable.length,
		conflicts.length,
	).waitForConfirmation();
	if (!confirmed) return;
	const result = await moveFiles(host, targetFolder, movable, conflicts.map((file) => file.path));
	new Notice(formatMoveResult(result));
	host.pruneMovedNotes(result.moved);
	host.updateUndoButton();
}

export async function undoLastMove(host: RelatedNotesMoveHost) {
	if (host.lastMove().length === 0) return;
	const paths = createPathIndex(host.app);
	const restored: string[] = [];
	const skipped: string[] = [];
	const failed: Array<{ path: string; reason: string }> = [];
	const remaining: MoveRecord[] = [];
	for (const record of [...host.lastMove()].reverse()) {
		const file = host.app.vault.getAbstractFileByPath(record.to);
		if (!(file instanceof TFile)) {
			failed.push({ path: record.to, reason: '文件已不存在或已被重命名' });
			remaining.push(record);
			continue;
		}
		if (paths.has(record.from)) {
			skipped.push(record.from);
			remaining.push(record);
			continue;
		}
		try {
			const folder = parentFolder(record.from);
			if (folder) await ensureFolder(host.app, folder, (created) => paths.add(created));
			await host.app.fileManager.renameFile(file, record.from);
			paths.remove(record.to);
			paths.add(record.from);
			restored.push(record.from);
		} catch (error) {
			failed.push({ path: record.from, reason: error instanceof Error ? error.message : '未知错误' });
			remaining.push(record);
		}
	}
	host.setLastMove(remaining.reverse());
	const lines = [`已撤销：${restored.length}`, `已跳过：${skipped.length}`, `失败：${failed.length}`];
	if (skipped.length) lines.push(`跳过文件：${skipped.join('、')}`);
	if (failed.length) lines.push(`失败文件：${failed.map((item) => `${item.path}（${item.reason}）`).join('、')}`);
	new Notice(lines.join('\n'));
	host.recomputeRelatedNotes();
}

export async function moveFiles(
	host: RelatedNotesMoveHost,
	targetFolder: string,
	selected: TFile[],
	initiallySkipped: string[] = [],
): Promise<MoveResult> {
	const result: MoveResult = { succeeded: [], skipped: initiallySkipped, failed: [], moved: [] };
	// Snapshot the vault once: checking every destination against the live file
	// list is O(files × selected) and stalls large batches. Our own renames keep
	// the index in sync, so two selected files never overwrite each other.
	const paths = createPathIndex(host.app);
	const targetCheck = targetFolderStatus(host.app, targetFolder);
	if (targetCheck.state === 'blocked') {
		result.failed.push(targetIsFileFailure(targetFolder, targetCheck.blocker ?? targetFolder));
		return result;
	}
	try {
		await ensureFolder(host.app, targetFolder, (created) => paths.add(created));
	} catch {
		const recheck = targetFolderStatus(host.app, targetFolder);
		result.failed.push(recheck.state === 'blocked'
			? targetIsFileFailure(targetFolder, recheck.blocker ?? targetFolder)
			: otherFolderFailure(targetFolder));
		return result;
	}
	for (const file of selected) {
		const destination = normalizePath(`${targetFolder}/${file.name}`);
		if (destination.toLowerCase() === file.path.toLowerCase() || paths.has(destination)) {
			result.skipped.push(file.path);
			continue;
		}
		try {
			const previousPath = file.path;
			await host.app.fileManager.renameFile(file, destination);
			paths.remove(previousPath);
			paths.add(destination);
			result.succeeded.push(file.path);
			result.moved.push({ from: previousPath, to: destination });
		} catch (error) {
			result.failed.push(renameFailure(file.path, error, paths.has(destination)));
		}
	}
	if (result.moved.length > 0) {
		// A partial batch is commonly retried with only the failed notes. Keep
		// the earlier successes in the undo record so a retry cannot silently
		// orphan them; undoing restores every batch in reverse order.
		host.setLastMove([...host.lastMove(), ...result.moved]);
		host.updateUndoButton();
	}
	return result;
}

function targetIsFileFailure(path: string, blocker: string): MoveFailure {
	return {
		path,
		reason: `目标路径中的「${blocker}」是文件`,
		kind: 'target-is-file',
		nextStep: '请改用其他文件夹名，或先把该文件移走。',
	};
}

function otherFolderFailure(path: string): MoveFailure {
	return {
		path,
		reason: '无法创建或访问目标文件夹',
		kind: 'other',
		nextStep: '请检查文件夹名称和写入权限后重试。',
	};
}

function renameFailure(path: string, error: unknown, destinationExists: boolean): MoveFailure {
	const message = error instanceof Error ? error.message : '未知错误';
	if (destinationExists || /eexist|already exists|已存在/i.test(message)) {
		return {
			path,
			reason: '目标位置已有同名笔记',
			kind: 'exists',
			nextStep: '请改用其他目标文件夹，或先重命名冲突笔记。',
		};
	}
	if (/eacces|eperm|permission|access (is )?denied|denied|权限|只读|拒绝/i.test(message)) {
		return {
			path,
			reason: '没有目标文件夹的写入权限',
			kind: 'permission',
			nextStep: '请检查文件夹权限后重试，或改用其他文件夹。',
		};
	}
	return {
		path,
		reason: message,
		kind: 'other',
		nextStep: '请稍后重试；若持续失败，请检查目标文件夹是否可写。',
	};
}

function createPathIndex(app: App) {
	const paths = new Set<string>();
	for (const file of app.vault.getAllLoadedFiles()) paths.add(file.path.toLowerCase());
	return {
		has(path: string) { return paths.has(path.toLowerCase()); },
		add(path: string) { paths.add(path.toLowerCase()); },
		remove(path: string) { paths.delete(path.toLowerCase()); },
	};
}

async function ensureFolder(app: App, path: string, onCreated?: (path: string) => void) {
	let current = '';
	for (const segment of path.split('/').filter(Boolean)) {
		current = current ? `${current}/${segment}` : segment;
		const existing = app.vault.getAbstractFileByPath(current);
		if (existing instanceof TFolder) continue;
		if (existing) throw new Error(`Path is not a folder: ${current}`);
		await app.vault.createFolder(current);
		onCreated?.(current);
	}
}
