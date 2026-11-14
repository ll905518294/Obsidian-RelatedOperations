# HANDOFF

> 给无上下文的新会话快速接力。当前任务完成且无遗留时保持简短。

## 状态
- 更新时间：2026-11-14
- 当前状态：多线程并行迭代中；体检面板已拆分为 `src/cleanup/` 模块，体检首页视觉与可访问性已整理

## 当前任务
- 5 条并行线程，由主管统一评审与提交：01 体检面板架构拆分、02 关联笔记与链接统计、03 扫描核心边界、04 发布链路与文档、05 体检首页交互与主题。
- 已推送 `6929388`：体检面板拆入 `src/cleanup/`、关联笔记合并同一目标视图、原生图片尺寸+别名与重复链接定位修复、体检面板主题与可访问性整理、文档与 lint 工作流对齐。
- 验证基线：`npm run build`、`npm run lint`、`npm test`（139 项）、`npm run deploy:check` 全部通过。未执行真正部署与 Obsidian 实机验证。

## 未完成
- 第二轮迭代进行中，完成后需由主管复核、提交并推送。
- 尚未在真实 Obsidian 中截图复核主题（浅色/深色/第三方）与移动端布局。

## 关键上下文
- 相关文件：`AGENTS.md`、`PROJECT_MEMORY.md`、`CHANGELOG.md`、`docs/`
- 验证命令：`npm run build`、`npm run lint`、`npm test`、`npm run test:deploy`、`npm run deploy:check`（后两者不会复制文件或重启 Obsidian）。
- 发布：推送与 `manifest.json` 的 `version` 完全一致（无 `v` 前缀）的 tag 触发 release workflow；workflow 先运行 `npm run lint` 与 `npm test`，通过后创建正式 release 并附带 `main.js`、`manifest.json`、`styles.css`；版本不匹配或测试失败会阻止发布。
- 部署：`npm run deploy` 失败时默认恢复 `.obsidian/plugin-backups/<plugin-id>.backup`；加 `-NoRollbackOnFail` 可保留新文件用于排查。
- 部署后确认：读取 `.obsidian/plugins/vault-doctor/manifest.json` 的 `version` 应与项目根 `manifest.json` 一致，且 `main.js` 的 `LastWriteTime` 不应早于本次构建。
- 已知坑与避免方式：不要把 `main.js`、`node_modules/` 或 Vault 数据文件当作源码提交。嵌套对象需显式 map 到 path string 再 add 到 selection Set。多线程共用同一工作区，临时脚本必须在收尾前删除，仓库根目录只保留源码、测试、文档与 `main.js`。
