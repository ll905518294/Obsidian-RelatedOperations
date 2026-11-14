# HANDOFF

> 给无上下文的新会话快速接力。当前任务完成且无遗留时保持简短。

## 状态
- 更新时间：2026-11-15
- 当前状态：插件已更名 Vault Doctor（id `vault-doctor`），1.3.0~1.3.2 已发布，1.4.0 为最新正式 release（重复文件删除守卫、关联笔记预览与焦点修复、社区提交流程文档更新）。仓库为公开的 `obsidian-vault-doctor`；README 已按体检定位重写并含 9 张截图，历史交接说明归档至 `docs/legacy-obsidian-plugin-handoff.md`。

## 当前任务
- 1.4.0 收口：重复文件删除前按组复核（每组保留 1 个 + 内容变化跳过）、关联笔记分组行预览与焦点、`.base` 链接边界、社区提交入口改为 community.obsidian.md 网页。
- 验证基线：`npm run build`、`npm run lint`、`npm test`（204 项）、`npm run test:deploy`、`npm run deploy:check` 全部通过。词法新旧实现 200,020 组随机对拍、原生链接替换新旧实现 30,000 组随机对拍均零差异。

## 2026-11-15 第五轮：界面与可访问性审计（已完成）
- 方法：解包官方 `obsidian-1.15.1.asar` 的 `app.css`（SHA-256 已核对一致），叠加用户实际生效的 Border 主题与插件 `styles.css`，在 ego lite/Chromium 中按 740/500/320 三档 × 浅深两主题复现 12 个场景；DOM 由 `gen-markup.mjs` 调用插件真实渲染函数生成，测量全部来自 `getBoundingClientRect` 与 `getComputedStyle`。
- 已修复：分类标签条的帮助按钮改为贴住右端（sticky），原在横向滚动端点外不可见；浅色主题下路径链接/图片名/分组标题（3.39~3.7）与首页图标（2.98）改用 `--ro-accent-text` 派生色；窄屏 `打开所在文件夹`、`删除` 命中区补到 44px；长文本单元格就地断行；分类按钮加 `aria-label`、当前标签加 `aria-current` 并滚入视口、帮助按钮补 `aria-controls`。
- 收口（同日追加）：撤销了「勾选框由 label 包裹」这一改动。实测 44×44 命中区来自 `input[type="checkbox"]` 自己的边框盒（`box-sizing: content-box`，content 30px + 7px 透明边框，320 档 `getBoundingClientRect` 实测 44×44），label 包裹并不贡献命中区；`wrapCheckboxInLabel()` 与全部 `label:has(> input[type="checkbox"])` 规则已删除，`associateCheckbox()` 只负责设 id 并回填 `aria-labelledby`。另把关联笔记侧剩余 4 处 `var(--text-accent)` 文字统一改为 `var(--ro-accent-text)`：浅色 3.19~3.56 → 5.41~6.03、深色 4.99~5.72 → 6.22~7.12（`.related-operations-final-target-text`、`.related-operations-confirm-target`、`.related-operations-tab.is-active`、`.related-operations-path-group td`）。因为 `related-operations-confirm-target` 用在关联笔记的确认弹窗里、不在面板作用域内，`--ro-accent-text` 的作用域补了 `.modal-content`（弹窗内实测 6.27 浅色 / 6.84 深色）。
- 本轮追加：清理表格补整表 `min-width`（普通表 460px、重复文件表 660px）。修复前 320 档重复表「文件/所在笔记/所在文件夹/状态」四列宽度为 0（路径列不可见、说明文本压到「操作」列）、附件表路径列仅 23px；改为横向滚动后各列均有可见宽度。
- 残留（判定为宿主层，非插件缺陷）：首页主按钮 `button.mod-cta` 白字 / `rgb(98,121,253)` 底，对比度 3.96（浅色 3.7）。来源是 Obsidian 官方 `app.css` 的 `button.mod-cta{background-color:var(--interactive-accent);--text-color:var(--text-on-accent)}`，插件与 Border 主题都没有定义该样式。
- 验证：`npm test` 194 通过 / 0 失败，`npm run build`、`npm run lint` 通过；另用真实样式探针复测 48 组组合，帮助按钮可见性、勾选命中区、小按钮、单元格溢出、文档级横向溢出全部符合预期。

## 未完成
- 社区市场尚未提交：`community-plugins.json` 中 `vault-doctor` / `Vault Doctor` 未被占用，manifest 与 release 均合规。提交入口已从 PR 改为网页表单：用 Obsidian 账号登录 <https://community.obsidian.md/> → 在 Profile → GitHub 选择 **Connect** 绑定 GitHub → **Plugins → New plugin** 填仓库 URL。目录读取默认分支 HEAD 的 `manifest.json`，并要求存在 tag 与 `version` 一致的正式 release（当前 `1.3.2` 已满足）。此前为走 PR 旧流程准备的 fork 分支 `add-vault-doctor` 已无用途（它仍留在 fork `ll905518294/obsidian-releases` 上，核实于 2026-11-15；可忽略，需要时可删除该 fork）。
- 第五轮的对比度与布局测量是在 ego lite/Chromium 仿真里完成的（官方 `app.css` + Border 主题 + 插件 `styles.css`），尚未在真实 Obsidian 内核里复现；截图存于 `C:\Users\Administrator\.codex\visualizations\2026\11\14\01a1d9da-adc1-7522-b34d-9e23978baea9\`，命名 `vault-doctor-r5-*`。

## 关键上下文
- 相关文件：`AGENTS.md`、`PROJECT_MEMORY.md`、`CHANGELOG.md`、`docs/`
- 验证命令：`npm run build`、`npm run lint`、`npm test`、`npm run test:deploy`、`npm run deploy:check`（后两者不会复制文件或重启 Obsidian）。
- 发布：推送与 `manifest.json` 的 `version` 完全一致（无 `v` 前缀）的 tag 触发 release workflow；workflow 先校验版本与 `versions.json` 映射，再运行 `npm run lint` 与 `npm test`，通过后创建正式 release 并附带 `main.js`、`manifest.json`、`styles.css`，发布说明写入版本、最低 Obsidian 版本与三件套 SHA-256。
- 部署：`npm run deploy` 失败时默认恢复 `.obsidian/plugin-backups/<plugin-id>.backup`；加 `-NoRollbackOnFail` 可保留新文件用于排查。
- 部署后确认：读取 `.obsidian/plugins/vault-doctor/manifest.json` 的 `version` 应与项目根 `manifest.json` 一致，且 `main.js` 的 `LastWriteTime` 不应早于本次构建。
- 已知坑与避免方式：不要把 `main.js`、`node_modules/` 或 Vault 数据文件当作源码提交。嵌套对象需显式 map 到 path string 再 add 到 selection Set。多线程共用同一工作区，临时脚本必须在收尾前删除，仓库根目录只保留源码、测试、文档与 `main.js`。
