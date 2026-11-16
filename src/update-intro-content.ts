export interface UpdateIntroSection {
	title: string;
	items: string[];
}

export interface UpdateIntro {
	version: string;
	theme: string;
	summary: string;
	sections: UpdateIntroSection[];
}

// Release notes are bundled with the code (the community build only ships
// main.js/manifest.json/styles.css), so every install sees the same summary.
// Keep newest first and add an entry with each release.
export const UPDATE_INTROS: UpdateIntro[] = [
	{
		version: '1.7.0',
		theme: '图片格式转换',
		summary: '体检与清理面板新增「图片转换」标签页：批量转换 PNG、JPG、WebP、BMP、AVIF，执行前精确预估可节省空间，并安全改写引用。',
		sections: [
			{
				title: '新功能',
				items: [
					'体检与清理面板新增「图片转换」标签页，位于标签条末尾；不属于 9 类体检问题，也不计入首页总数、健康度与 6 阶段扫描。',
					'支持 PNG、JPG、WebP、BMP、AVIF 转 JPG、WebP 或 PNG，质量 50–95，透明图可选白底或跳过。',
					'转换前对每张候选图真实重编码一次，显示候选数、当前体积、转换后体积与预计节省。',
					'逐张事务执行并安全改写引用：覆盖 Wiki 嵌入（保留别名与尺寸）、标准 Markdown 链接、HTML img、frontmatter 路径与 Canvas 节点；失败回滚并保留原图。',
				],
			},
			{
				title: '改进',
				items: [
					'默认只勾选 PNG、目标格式 JPG、质量 85、透明图白底；`.obsidian`、隐藏目录与设置中的「忽略目录」会被排除。',
					'不处理 GIF、SVG、TIFF、HEIC/HEIF、ICO。',
					'转换会丢弃 EXIF/GPS/ICC 与色彩配置文件，照片方向由浏览器自动扶正；不缩放、不裁剪，原图恢复依赖 Obsidian 回收站。',
				],
			},
		],
	},
	{
		version: '1.6.3',
		theme: '使用引导加入界面截图',
		summary: '使用引导三步各加入一张界面截图，分别展示扫描结果、重复文件清理与体检首页，更直观。',
		sections: [
			{
				title: '改进',
				items: [
					'使用引导第一步展示扫描结果页，说明 9 类体检问题。',
					'使用引导第二步展示重复文件列表，说明选择、确认与两段式删除。',
					'使用引导第三步展示体检首页，指引点击「开始扫描」。',
				],
			},
		],
	},
	{
		version: '1.6.2',
		theme: '弹窗标注软件名与版本',
		summary: '使用引导与更新说明弹窗现在会显示软件名称「Vault Doctor」和当前版本号，方便识别你打开的是哪个软件的说明。',
		sections: [
			{
				title: '改进',
				items: [
					'使用引导与更新说明弹窗顶部都会标注软件名称「Vault Doctor」与当前版本号。',
				],
			},
		],
	},
	{
		version: '1.6.1',
		theme: '所有用户都能看到使用引导',
		summary: '修复升级老用户打开软件看不到使用引导的问题，未看过引导的用户现在都会自动弹一次；功能与 1.6.0 保持一致。',
		sections: [
			{
				title: '修复',
				items: [
					'未看过使用引导的用户（包括从旧版本升级的老用户）现在打开软件时都会自动弹一次三步引导。',
				],
			},
			{
				title: '新功能',
				items: [
					'首次自动弹出 3 步「使用引导」：它能做什么、安全说明、怎么开始，支持上一步 / 下一步，结尾可开始使用 / 立即打开体检 / 跳过。',
					'新增命令「打开使用引导」，可随时从命令面板重新查看。',
				],
			},
			{
				title: '改进',
				items: [
					'设置新增「首次显示使用引导」开关，可关闭首次自动弹出。',
					'插件明确为仅桌面端（isDesktopOnly）。',
				],
			},
		],
	},
	{
		version: '1.6.0',
		theme: '首次使用引导',
		summary: '新增首次安装的三步使用引导，并明确插件为仅桌面端；升级到 1.6.0 后即可在此查看本次改动。',
		sections: [
			{
				title: '新功能',
				items: [
					'首次安装并加载插件时自动弹出 3 步「使用引导」：它能做什么、安全说明、怎么开始。',
					'引导支持「上一步 / 下一步」逐页浏览，最后可「开始使用 / 立即打开体检 / 跳过」。',
					'新增命令「打开使用引导」，可随时从命令面板重新查看三步引导。',
				],
			},
			{
				title: '改进',
				items: [
					'设置新增「首次显示使用引导」开关，可关闭首次安装时的自动弹出。',
					'插件明确为仅桌面端（isDesktopOnly），不再在移动端尝试加载运行。',
				],
			},
		],
	},
	{
		version: '1.5.0',
		theme: '版本更新欢迎',
		summary: '新增内置的版本更新欢迎弹窗与「查看更新说明」命令，升级后可随时了解本次改动。',
		sections: [
			{
				title: '新功能',
				items: [
					'新增「版本更新欢迎」弹窗：插件升级后首次打开时自动展示一次中文更新说明，按新功能、改进与修复分类。',
					'弹窗提供「开始使用」按钮，关闭后即可继续使用。',
					'新增命令「查看更新说明」，可随时从命令面板重新打开当前版本的更新说明。',
				],
			},
			{
				title: '改进',
				items: [
					'更新说明随插件包内置发布，不依赖网络，离线或移动端同样可查看。',
					'同一版本的欢迎弹窗只展示一次，已查看后不会重复打扰。',
				],
			},
		],
	},
	{
		version: '1.4.5',
		theme: '移动端兼容与清理面板收尾',
		summary: '本次更新补齐了移动端的稳定性问题，并收尾体检面板的交互与可访问性细节。',
		sections: [
			{
				title: '新功能',
				items: [
					'体检面板覆盖 9 类问题：未引用图片与附件、空文件与空文件夹、失效链接与原生链接、Wiki 笔记链接、重复文件等。',
					'关联笔记整理支持多选源笔记、按源笔记或路径分组，并可直接移动。',
					'Wiki 笔记链接可一键转换为标准 Markdown 链接，支持别名、标题锚点与块引用。',
				],
			},
			{
				title: '改进',
				items: [
					'扫描失败时在概览区保留失败分类与原因，可重新扫描重试。',
					'列表复选框与同行可见文本关联，读屏能读出对应的文件或链接。',
					'列表刷新或切换后恢复焦点与滚动位置，减少重复定位。',
				],
			},
			{
				title: '修复',
				items: [
					'修复移动端没有 Node process 全局时打开体检面板报错的问题。',
					'修复图标按钮进入两段式删除待确认态后，读屏仍读出旧名称的问题。',
					'修复 Wiki 链接标题中含 %、# 等字符时目标地址被错误解析的问题。',
				],
			},
		],
	},
];

function normalizeVersion(value: string | null | undefined): string {
	return (value ?? '').trim().replace(/^v/i, '');
}

export function shouldShowIntro(installedVersion: string, lastSeenVersion: string | null | undefined): boolean {
	const installed = normalizeVersion(installedVersion);
	if (!installed) return false;
	return normalizeVersion(lastSeenVersion) !== installed;
}

export function currentUpdateIntro(version: string): UpdateIntro | undefined {
	const target = normalizeVersion(version);
	if (!target) return undefined;
	return UPDATE_INTROS.find((intro) => normalizeVersion(intro.version) === target);
}
