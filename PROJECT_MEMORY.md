# PROJECT_MEMORY

> 只记录已验证、长期有效且可复用的项目事实；当前任务进度写入 `HANDOFF.md`。

## 项目概览
- 名称：Obsidian-Manager（仓库目录：`Obsidian-RelatedOperations`）
- 目标与非目标：检查 Vault 健康状况、整理关联笔记、清理未引用资源；不覆盖已有文件，不自动删除文件。
- 技术栈：TypeScript、Obsidian API、esbuild、Node.js 原生测试。

## 常用命令与目录
- 安装 / 运行 / 构建 / 测试：`npm install`、`npm run dev`、`npm run build`、`npm test`、`npm run lint`
- 部署校验 / 部署：`npm run deploy:check`、`npm run deploy`
- 关键目录职责：`src/` 为插件逻辑，`tests/` 为原生 Node 测试，`scripts/` 为部署脚本。

## 稳定约定与限制
- 构建产物 `main.js` 写入项目根目录并供 Obsidian 加载；源码依赖需由 esbuild 打包。
- 关联笔记只处理已解析的 Markdown 文件；清理操作使用 Obsidian 原生文件管理器或本地回收站。
- 部署前构建并校验 `main.js`、`manifest.json` 和可选的 `styles.css`；失败时保留或恢复备份。

## 已验证结论
### 插件入口与模块边界
- 事实：`src/main.ts` 负责生命周期、命令、视图和菜单注册；关联笔记、清理、链接统计、设置等逻辑分别位于独立模块。
- 证据：当前 `src/main.ts` 的导入与注册调用，以及 `src/` 下对应模块文件。
- 影响与注意事项：新增功能优先放入现有职责模块，避免继续膨胀入口文件。

### 验证基线
- 事实：项目定义了 `npm run build`、`npm run lint`、`npm test` 和部署校验命令。
- 证据：`package.json` scripts。
- 影响与注意事项：代码改动至少运行相关测试；发布前运行构建和部署预检。
