# RUNBOOK

## 1. 本地启动
- 环境：Node.js 18+；测试脚本使用 Node.js 22+ 的原生 TypeScript 类型擦除选项。
- 安装：`npm install`
- 开发监听：`npm run dev`

## 2. 构建与测试
- 生产构建：`npm run build`
- 单元测试：`npm test`
- 静态检查：`npm run lint`
- 部署预检：`npm run deploy:check`（只构建和检查，不复制、不重启）
- 部署并重启：`npm run deploy`
- 产物：项目根目录的 `main.js`，以及 `manifest.json`、可选 `styles.css`。

## 3. 常见问题排查
### 插件未加载
1. 运行 `npm run build`。
2. 确认 Vault 的 `.obsidian/plugins/Obsidian-RelatedOperations/` 存在 `main.js`、`manifest.json`。
3. 在 Obsidian 中重新加载或启用社区插件。

### 部署停止
- 常见原因：没有唯一的 `open=true` Vault、构建失败、Obsidian CLI 不可用或重启不稳定。
- 先运行 `npm run deploy:check`，确认目标 Vault 和构建产物。

## 4. 发布前检查
1. `npm run build`
2. `npm run lint`
3. `npm test`
4. 检查 `manifest.json` 版本与 `versions.json` 映射一致。

## 5. 回滚
- 部署脚本会把旧插件目录保存为同级 `.backup`；复制或重启失败时自动尝试恢复。
- 若需人工恢复，确认备份路径为目标插件目录后缀 `.backup`，再恢复并重新加载 Obsidian。

## 6. 关键路径
- 源码：`src/`
- 测试：`tests/`
- 部署脚本：`scripts/deploy-and-restart.ps1`
- 构建配置：`esbuild.config.mjs`
