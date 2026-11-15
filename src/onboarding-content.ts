import { shouldShowIntro } from './update-intro-content.ts';

export interface OnboardingItem {
	text: string;
	kbd?: string;
	after?: string;
}

export interface OnboardingStep {
	title: string;
	summary: string;
	items: OnboardingItem[];
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
	{
		title: '它能做什么',
		summary: '两个核心能力：体检整库资源，以及整理关联笔记。',
		items: [
			{ text: '体检 9 类问题：未引用图片与附件、空文件与空文件夹、失效笔记链接与原生图片链接、Wiki 笔记链接、重复文件等。' },
			{ text: '关联笔记整理：多选源笔记，按源笔记或路径分组，确认后可直接移动。' },
		],
	},
	{
		title: '安全说明',
		summary: '扫描只读，不会擅自改动你的任何文件。',
		items: [
			{ text: '扫描只读取目录与链接信息，不会修改文件内容。' },
			{ text: '只有你主动确认的操作才会执行；未选中的条目不会被动到。' },
			{ text: '删除采用两段式确认：第一次点击只进入待确认状态，再点一次才会删除，避免误删。' },
		],
	},
	{
		title: '怎么开始',
		summary: '从左侧栏或命令面板打开体检面板，然后按问题数量优先处理。',
		items: [
			{ text: '点击左侧栏的 ', kbd: '+', after: ' 方框图标，或使用命令面板中的「打开 vault 体检与清理」。' },
			{ text: '进入体检面板后，点击右上角「开始扫描」。' },
			{ text: '在体检首页按问题数量从多到少优先处理；不确定的项目可以先跳过。' },
		],
	},
];

export type StartupIntroDecision = 'onboarding' | 'update' | 'none';

/**
 * Decides which first-run surface to show once the workspace is ready.
 *
 * The onboarding wizard takes priority: it shows until the user has seen it
 * once (`onboardingSeen === false`), regardless of whether the vault is brand
 * new or an upgrade with existing settings, so every user who has not seen the
 * wizard yet will get it when the plugin loads. Once seen, version changes
 * fall back to the update notes and identical versions stay silent.
 */
export function decideStartupIntro(installedVersion: string, lastSeenVersion: string | null | undefined, onboardingSeen: boolean): StartupIntroDecision {
	if (!installedVersion.trim()) return 'none';
	if (!onboardingSeen) return 'onboarding';
	return shouldShowIntro(installedVersion, lastSeenVersion) ? 'update' : 'none';
}
