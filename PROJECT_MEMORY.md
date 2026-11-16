# PROJECT_MEMORY

> 只记录已验证、长期有效且可复用的项目事实；当前任务进度写入 `HANDOFF.md`。

## 项目概览
- 名称：Vault Doctor（插件 id：`vault-doctor`；GitHub 仓库与本地目录：`obsidian-vault-doctor`）
- 目标与非目标：检查 Vault 健康状况、整理关联笔记、清理未引用资源、转换图片格式；不覆盖已有文件，扫描阶段不改动任何文件，清理操作只在用户勾选并确认后才把文件移入 Obsidian 回收站或系统回收站。
- 技术栈：TypeScript、Obsidian API、esbuild、Node.js 原生测试。

## 常用命令与目录
- 安装 / 运行 / 构建 / 测试：`npm install`、`npm run dev`、`npm run build`、`npm test`、`npm run lint`
- 打包安装包 / 打包预检：`npm run package`（产出 `dist/vault-doctor-<版本号>.zip`）、`npm run package:check`
- 部署校验 / 部署：`npm run deploy:check`、`npm run deploy`
- 关键目录职责：`src/` 为插件逻辑，`tests/` 为原生 Node 测试，`scripts/` 为部署脚本与打包脚本（`scripts/package-plugin.mjs`）。

## 稳定约定与限制
- 构建产物 `main.js` 写入项目根目录并供 Obsidian 加载；源码依赖需由 esbuild 打包。
- 发版：`npm version <x.y.z> --no-git-tag-version` 更新 `package.json`、`package-lock.json`，并由 `version-bump.mjs` 把 `manifest.json`、`versions.json` 同步到同一版本（`versions.json` 新版本映射到当前 `minAppVersion`）。发版前必须在 `src/update-intro-content.ts` 顶部加入同版本条目，否则升级弹窗没有内容；`tests/update-intro-content.test.mjs` 会校验结构与主题，并要求最新版本排在最前。
- 发版顺序：升版本 → 写 CHANGELOG → 加内置更新说明 → `npm run build` → `npm run package` → 推送与 `manifest.version` 完全一致的 tag。`main.js` 由 CI 重新构建，本地 `dist/*.zip` 只用于校验。本仓库 `1.8.0` 未创建 tag/release；`1.9.0` 汇总自 `1.7.0` 以来的变更，tag 必须等于 `manifest.version`（无 `v` 前缀）。
- 发布资产为 Obsidian 标准三件套 `main.js`、`manifest.json` 与可选的 `styles.css`；ZIP 只是把三件套打在根层的便捷形式，不是 Windows 安装器，`dist/` 属于生成物并已被 `.gitignore` 忽略。
- 关联笔记只处理已解析的 Markdown 文件；清理操作使用 Obsidian 原生文件管理器或本地回收站。
- 部署前构建并校验 `main.js`、`manifest.json` 和可选的 `styles.css`；失败时保留或恢复备份。
- 界面文字强调色用 `var(--ro-accent-text)`，不要直接用 `--text-accent`：浅色主题下 `--text-accent` 对比度只有 3.19~3.56（低于正文 4.5），深色下 4.99~5.72 已达标；`--ro-accent-text` 是 `color-mix(in srgb, var(--text-accent) 65%, var(--text-normal))`，浅色提到 5.41~6.03、深色提到 6.22~7.12。该变量定义在 `.related-operations-panel`、`.orphan-cleanup-panel` 与 `.modal-content` 上——`related-operations-confirm-target` 用在关联笔记的确认弹窗里，弹窗不在面板作用域内。
- 列表勾选框不套 `label`：窄屏 44×44 命中区来自 `input[type="checkbox"]` 自己的边框盒（`box-sizing: content-box`，content 30px + 7px 透明边框），可见文本由 `aria-labelledby` 关联。`associateCheckbox()` 只负责给可见文本设 id 并回填 `aria-labelledby`，不改动勾选框的父节点。
- 清理表格必须设整表 `min-width`（普通表 460px、重复文件表 660px）：窄视口下「勾选 44px + 操作 145px」这些固定列会把中间列压到 0，改由 `.orphan-cleanup-scroll` 横向滚动。
- 体检缓存写入 `data.json` 前必须序列化成纯数据（`src/cleanup/cleanup-cache.ts`，`CLEANUP_CACHE_VERSION = 2`）：只保留路径与 `size`/`mtime`，读取时按路径重新解析成 `TFile`/`TFolder`；转换候选 `convertibleImages` 永远写空，估算结果不落盘。旧缓存或已删除文件由 `restoreCleanupCandidates` 逐项校验后丢弃，不能让面板崩溃。
- 图片转换默认值来自 `DEFAULT_IMAGE_CONVERSION`（`src/cleanup/cleanup-types.ts`）：源格式只含 PNG、目标 JPG、质量 85、透明图白底；设置页只暴露目标格式/默认质量/透明图处理三项，源格式只在页面内勾选。改默认值时要同步 `tests/settings-defaults.test.mjs` 与 README。
- 图片转换估算结果复用的键是 `target|quality|alpha` 加源文件 `size`/`mtime`：只改源格式不会重新编码；改目标格式、质量或透明图处理会让旧估算失效。全量扫描只枚举候选，估算只在图片转换页点「扫描并估算」时触发。
- 截图流程：演示库 `vault-doctor-demo` 含合成数据，但图片转换会真实改写文件并清空原图，因此转换类截图必须在**临时复制件**里拍摄（复制目录可同名以保持界面左下角库名一致）；截图用窗口客户区抓屏，保持 1920×1032。切换 Vault 前先备份 `obsidian.json`（位于用户配置目录的 `obsidian` 文件夹），拍完恢复备份并重启回真实库。

## 已验证结论
### 插件入口与模块边界
- 事实：`src/main.ts` 负责生命周期、命令、视图和菜单注册；关联笔记、清理、设置等逻辑分别位于独立模块。
- 证据：当前 `src/main.ts` 的导入与注册调用，以及 `src/` 下对应模块文件。
- 影响与注意事项：新增功能优先放入现有职责模块，避免继续膨胀入口文件。
- 事实：`src/image-convert/image-convert-links.ts` 只是再导出入口，实际实现位于 `image-reference-types.ts`、`image-reference-path.ts`、`image-reference-parser.ts`、`image-reference-scan.ts`、`image-reference-rewrite.ts` 与 `image-reference-analysis.ts`。
- 证据：`image-convert-links.ts` 的 `export ... from` 列表，以及 `src/image-convert/` 下对应文件。
- 影响与注意事项：新增引用格式或改写规则时改对应职责模块，不要重新把逻辑堆回 `image-convert-links.ts`。

### 验证基线
- 事实：项目定义了 `npm run build`、`npm run lint`、`npm test`、`npm run package`、`npm run package:check` 和部署校验命令。
- 证据：`package.json` scripts。
- 影响与注意事项：代码改动至少运行相关测试；发布前运行构建、打包与部署预检。测试条数随并行开发变化，不应把某个具体数字当作长期事实。

### 体检清理面板架构（OrphanCleanupPanel）
- 事实：`OrphanCleanupPanel` 与 `OrphanCleanupModal` 位于 `src/cleanup/cleanup-panel.ts`；`src/orphan-cleanup.ts` 是再导出入口，`src/orphan-cleanup-view.ts` 提供工作区 `ItemView` 宿主。面板使用多 Tab 结构（overview/images/attachments/broken-links/native-links/broken-note-links/wiki-links/empty-files/folders/duplicates）；`image-convert`（图片转换）由 `tabEntries()` 追加在标签条末尾，不属于 `CLEANUP_CATEGORIES`，因此不计入 9 类体检问题与 6 阶段扫描；首页用独立卡片展示，有可转换候选时计入「当前待处理」总数，全量扫描不包含图片转换，进入页签只枚举候选、不解码。
- 每个 Tab 有独立的 selection Set：`selections`（文件类）、`linkSelections`（失效图片链接）、`nativeSelections`（原生链接）、`noteLinkSelections`（失效笔记链接）、`duplicateSelections`（重复文件）。
- 多选模式统一模式：声明 Set → scan() 中 clear → renderList() 中添加 addSelectionControls → 每行 checkbox → renderActions() 和 updateSelectionSummary() 处理该 Tab。
- 注意事项：nested 对象（如 DuplicateFileGroup.files）需显式 `.map(f => f.path)` 转成 string 再 add 到 Set，否则 TypeScript 类型报错。
- 批量操作入口：`renderActions()` 中的主按钮文字根据 activeTab 变化；`updateSelectionSummary()` 根据 activeTab 显示不同摘要文本。
