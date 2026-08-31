# ARCHITECTURE

> 描述插件的模块边界、数据流和稳定约束；实现变化后以代码行为为准同步更新。

## 1. 项目目标
- 解决：在 Obsidian Vault 中发现关联笔记、断链、未引用资源和重复文件，并提供可确认的整理/清理操作。
- 用户：需要维护笔记关系和 Vault 健康状况的 Obsidian 用户。
- 不解决：不覆盖目标文件，不把重复文件自动删除，不把外部云服务作为运行前提。

## 2. 系统概览
- 核心模块：
  - `src/main.ts`：插件生命周期、命令、Ribbon、菜单和视图注册。
  - `src/related-notes*.ts`：关联笔记计算、桌面视图和移动端 Modal。
  - `src/orphan-cleanup*.ts`：Vault 体检与清理流程、桌面视图和移动端 Modal。
  - `src/broken-*-links.ts`、`src/native-image-links.ts`：链接扫描与转换。
  - `src/cleanup-*.ts`、`src/duplicate-files.ts`：候选筛选、风险分级、报告和重复文件扫描。
  - `src/link-stats*.ts`：关联数量属性维护。
  - `src/settings.ts`、`src/core-utils.ts`：设置与共享规则。
- 外部依赖：Obsidian API；可选集成 Notebook Navigator。

## 3. 关键数据流
1. Obsidian 命令、Ribbon 或菜单触发入口。
2. 插件从 Vault/metadata cache 收集 Markdown、Canvas 和资源信息。
3. 扫描模块生成可操作候选，视图展示并要求用户确认。
4. 执行阶段使用 Obsidian 文件 API 或编辑历史；报告可复制或写入 Vault 根目录。

## 4. 关键约束
- 只对已解析或可安全判定的目标执行操作；外部 URL、代码块和 frontmatter 按功能规则保守处理。
- 不覆盖已有目标文件；失败项与已完成项分别报告。
- 监听器、定时器和视图必须通过 Obsidian 注册机制清理。
- 移动端避免依赖桌面 Electron API，桌面功能提供 Modal fallback。

## 5. 当前边界
- Notebook Navigator 为可选插件，未安装时核心功能仍应可用。
- 部署脚本依赖当前打开的唯一 Vault 和本机 Obsidian CLI。
