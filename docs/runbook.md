# RUNBOOK

## 1. 本地启动
- 环境：Node.js 22+（`package.json` 的 `engines` 要求 `>=22`；测试脚本使用原生 TypeScript 类型擦除选项）。
- 安装：`npm install`
- 开发监听：`npm run dev`

## 2. 构建与测试
- 生产构建：`npm run build`
- 单元测试：`npm test`
- 静态检查：`npm run lint`
- 部署脚本测试：`npm run test:deploy`
- 部署预检：`npm run deploy:check`（只构建和检查，不复制、不重启）
- 部署并重启：`npm run deploy`（失败时默认恢复到备份；加 `-NoRollbackOnFail` 可保留新文件用于排查）
- 产物：项目根目录的 `main.js`，以及 `manifest.json`、可选 `styles.css`。
- 平台范围：插件为仅桌面端（`isDesktopOnly: true`），移动端不做验证。原因是 `src/cleanup/cleanup-actions.ts` 通过 `window.require('electron')` 调用系统资源管理器定位文件，移动端没有该能力。

## 3. 常见问题排查
### 插件未加载
1. 运行 `npm run build`。
2. 确认 Vault 的 `.obsidian/plugins/vault-doctor/` 存在 `main.js`、`manifest.json`。
3. 在 Obsidian 中重新加载或启用社区插件。

### 部署停止
- 常见原因：没有唯一的 `open=true` Vault、构建失败、Obsidian CLI 不可用或重启不稳定。
- 先运行 `npm run deploy:check`，确认目标 Vault 和构建产物。
- `npm run deploy:check` 在构建后执行与部署相同的 Vault/CLI 预检，因此没有 `open=true` 的唯一 Vault 或找不到 `obsidian.com` 时也会失败；它不会复制文件或重启 Obsidian。

### 部署后确认新版本
在项目根目录运行以下命令，读取唯一打开的 Vault 中已部署插件的版本与文件时间戳：

```powershell
$registry = Get-Content (Join-Path $env:APPDATA 'obsidian\obsidian.json') -Raw | ConvertFrom-Json
$vault = $registry.vaults.PSObject.Properties | Where-Object { $_.Value.open -eq $true } | ForEach-Object { $_.Value.path } | Select-Object -First 1
$plugin = Join-Path $vault '.obsidian\plugins\vault-doctor'
"项目版本: " + (Get-Content .\manifest.json -Raw | ConvertFrom-Json).version
"部署版本: " + (Get-Content (Join-Path $plugin 'manifest.json') -Raw | ConvertFrom-Json).version
Get-Item (Join-Path $plugin 'main.js') | Select-Object FullName, Length, LastWriteTime
```

判定：`部署版本` 应与 `项目版本` 一致，且 `main.js` 的 `LastWriteTime` 不应早于本次构建时间；否则说明 Obsidian 仍在加载旧文件，或插件未启用。

## 4. 发布前检查

先读取当前版本号，后续步骤都以它为准：

```powershell
$v = node -e "process.stdout.write(require('./manifest.json').version)"
```

逐项勾选（全部通过后再推送 tag）：

- [ ] 版本号为 SemVer 且无 `v` 前缀（如 `1.0.1`）。
- [ ] `versions.json` 已把 `$v` 映射到 `manifest.json` 的 `minAppVersion`。
- [ ] `npm run build` 通过，项目根生成了最新 `main.js`。
- [ ] `npm run lint` 通过。
- [ ] `npm test` 通过（原生测试全部绿）。
- [ ] 本次包含图片转换时，按第 9 节在演示库完成验证。
- [ ] `npm run test:deploy` 与 `npm run deploy:check` 通过（两者都不复制文件、不重启 Obsidian）。
- [ ] 三件套存在：`Get-Item main.js, manifest.json, styles.css`。
- [ ] tag 与版本一致：`git tag --list $v`（应显示 `$v`），用 `git push origin $v` 推送。
- [ ] 发布后核对：`gh release view $v --json tagName,name,body,assets`，确认 `assets` 包含 `main.js`、`manifest.json`、`styles.css`（若存在）。
- [ ] 可选：`Get-FileHash main.js, manifest.json, styles.css -Algorithm SHA256`，与 release 正文中的 SHA-256 对照。

发布后 release workflow 会再次运行 `npm run lint` 与 `npm test`；任一步失败、版本不匹配或 `versions.json` 映射不一致都会阻止发布。

## 5a. 发布后回退预案

仅处置“已发布但坏的版本”时使用；已部署到用户侧的文件不会因仓库侧操作自动回滚。

- **删除或转 pre-release 坏版本**：GitHub 官方文档确认，有写权限者可创建、编辑或删除 release，可将坏版本的 release 转为 pre-release 或删除。删除 release 对“已下载/已安装用户”文件的影响，以及删除后是否保留对应 tag，官方文档未明确说明，属推断。
- **发布修复版**：在修复后递增 `manifest.json` 的 `version`（SemVer），更新 `versions.json` 映射，推送与版本完全一致的新 tag，让新 release 覆盖在 Obsidian 中可见的下载入口。
- **`versions.json` 的影响**：它只决定低版本 Obsidian 应选择哪个发布，不会强制已装用户回滚到旧版本。
- **社区提交入口**：`obsidianmd/obsidian-releases` 已关闭 Issue 与 PR（PR 列表接口返回 404），插件提交改在 <https://community.obsidian.md/> 网页完成：需 Obsidian 账号登录并绑定 GitHub，目录读取默认分支 HEAD 的 `manifest.json`，并要求存在 tag 与 `version` 一致的正式 release。
- **社区列表镜像**：`community-plugins.json` 的清单镜像约每小时刷新一次（GitHub Actions `cron` 为整点后 17 分钟），但插件具体版本由客户端运行时直接从 GitHub releases 读取，官方未承诺固定可见时延，具体时延未验证。

## 5. 回滚
- 部署脚本会把旧插件目录保存为 `.obsidian/plugin-backups/<plugin-id>.backup`；复制或重启失败时默认自动尝试恢复，传入 `-NoRollbackOnFail` 则保留新文件用于排查。
- 备份必须位于 `plugins` 目录之外，否则 Obsidian 会发现同 ID 的备份并可能加载旧代码。部署会将历史同级 `.backup` 移入 `plugin-backups`，保留为独立历史备份。
- 普通 `.backup` 每次部署覆盖为最近一次；历史 `<plugin-id>.legacy-<guid>` 备份不会自动清理，需要时手动删除以释放磁盘。
- 若需人工恢复，确认备份与目标插件 ID 一致，再恢复并重新加载 Obsidian。

## 6. 关键路径
- 源码：`src/`
- 测试：`tests/`
- 部署脚本：`scripts/deploy-and-restart.ps1`
- 构建配置：`esbuild.config.mjs`

## 7. 社区目录提交（1.4.x）

提交入口为 <https://community.obsidian.md/> 网页表单（`obsidianmd/obsidian-releases` 的 Issue/PR 通道已关闭）。本节事实均于 2026-11-15 用 `gh` 拉取官方文档与 `community-plugins.json` 核实。

### 7.1 插件现值（`manifest.json`）

- `id`：`vault-doctor`
- `name`：`Vault Doctor`
- `author`：`ll905518294`
- `description`：`Scan your vault for broken links, unreferenced resources and duplicate files, then safely organize related notes.`（< 250 字符、以句号结尾、无 emoji）
- `minAppVersion`：`1.13.0`
- `isDesktopOnly`：`true`（插件定位为仅桌面端）
- `fundingUrl`：未设置（不收赞助，符合要求，勿添加）

### 7.2 审核要点逐条对照

| 官方要求（来源） | 本项目现状 | 结论 |
| --- | --- | --- |
| README 描述用途与使用方法（Submit guide） | README 首屏“用途”+「快速上手」「检查项说明」覆盖 | 满足 |
| 根目录有 LICENSE 并注明协议（Developer policies） | `LICENSE`（0-BSD），README 末尾注明 | 满足 |
| 根目录有 `manifest.json`（Submit guide） | 存在，`id` 唯一 | 满足 |
| `id` 全目录唯一且不含 `obsidian`（Submit guide） | 最新 `community-plugins.json` 未出现 `vault-doctor`；id 不含 `obsidian` | 满足 |
| description ≤ 250、句号结尾、无 emoji（Submission requirements） | 见 7.1 | 满足 |
| `minAppVersion` 为实际最低兼容版本（Submission requirements） | `1.13.0` | 满足 |
| `fundingUrl` 仅用于赞助链接（Submission requirements） | 未设置 | 满足 |
| Node.js/Electron API 则 `isDesktopOnly=true`（Submission requirements） | 插件定位仅桌面端，`manifest.json` 已设 `isDesktopOnly: true`；`window.require('electron')` 用于在系统资源管理器中定位文件 | 满足 |
| 不在命令 ID 中重复插件 ID（Submission requirements） | 命令 ID 未内嵌 `vault-doctor` | 满足 |
| 移除模板示例代码（Submission requirements） | 已按体检定位重写，无模板样例残留 | 满足 |
| 不混淆代码、无动态广告、无客户端遥测、不自更新（Developer policies） | 插件无网络请求、无遥测、不自更新 | 满足 |
| 网络使用需在 README 披露（Developer policies） | 无网络请求，README 已声明 | 满足 |
| 不访问 Vault 之外文件，除非披露（Developer policies） | 仅访问当前 Vault；「在资源管理器中显示」只定位文件，README 已说明 | 满足 |
| 遵守 Obsidian 商标（Developer policies） | 名称与 README 未暗示官方第一方 | 满足 |
| 存在 tag 与 `manifest.version` 一致的正式 release（Submit guide / README） | `gh release view 1.4.2`：正式 release、tag=1.4.2、资产含 `main.js`、`manifest.json`、`styles.css` | 满足 |

### 7.3 提交操作步骤（用户本人完成）

1. 浏览器打开 <https://community.obsidian.md/>，用 Obsidian 账号登录。
2. 在 Profile 中把 GitHub 账号 **Connect** 到该账号（用于验证仓库归属）。
3. 进入 **Plugins → New plugin**，填写仓库 URL：`https://github.com/ll905518294/obsidian-vault-doctor`。
4. 目录会读取默认分支 HEAD 的 `manifest.json`，因此提交前先提交并推送 `manifest.json`。
5. 提交后由自动审核给出反馈；需修正时更新仓库并发布**递增版本**的新 release（版本号必须与 tag 完全一致）。
6. 通过后可在论坛 Share & showcase 与 Discord `#updates` 公告。

## 8. 截图与 README 一致性维护

README 的 9 张截图位于 `docs/images/`。1.4.x 截图状态：

- **已用演示库实拍替换（6 张，无缺口）**：通过 Obsidian CDP 在纯合成演示库 `vault-doctor-demo` 实拍，1920×1032，深色 Border 主题，9 分类齐全（含「Wiki 笔记链接」页签），内容全为虚构示例数据，不含任何真实项目/客户/公司名。
  - `01-dashboard.png`：体检首页 · 扫描前 `0/9`
  - `02-scan-result.png`：扫描完成 `9/9`
  - `03-unused-images.png`：未引用图片 2 张
  - `04-broken-links.png`：失效笔记链接 1 条
  - `05-empty-files.png`：空文件 2 个
  - `06-duplicate-files.png`：重复文件 1 组
- **无需更新**：`07-related-notes.png`（关联笔记整理）与 `08-settings.png`（插件设置）与当前实现一致。

更新截图时保持文件名不变，避免改动 README 引用；不要用真实 Vault 截图（会暴露私有内容），统一使用演示库实拍并保持 9 个分类页签齐全。

1.7.0 新增「图片转换」页签后，`01-dashboard.png`、`02-scan-result.png` 仍是 9 分类旧图，尚未包含该页签；补拍前不要复用旧图冒充 1.7.0 界面，README 的图片转换章节暂以文字说明为准。

## 9. 1.7.0 图片转换验证

1.7.0 的 `manifest.json` 版本为 `1.7.0`，`versions.json` 映射为 `"1.7.0": "1.13.0"`。发布前用演示库 `X:\Obsidian\vault-doctor-demo` 验证图片转换：

1. 准备同一张 PNG 的三处引用：Wiki 嵌入（含别名、不含尺寸参数）、标准 Markdown 图片链接、HTML `<img src>`；确认三篇笔记都指向该 PNG。
2. 打开 **体检与清理 → 图片转换**，源格式只勾选 PNG，目标格式选 JPG，质量 85，透明图处理选白底。
3. 记录列表显示的候选数、当前体积、转换后体积与预计节省。
4. 执行转换，确认三处引用都改为 `.jpg`：Wiki 嵌入保留别名，Markdown 链接保留标题与 URL 编码，HTML 的 `src` 同步更新。
5. 重新扫描全部 9 类问题，确认失效图片链接与失效笔记链接均为 0，且没有新增失效引用。
6. 用文件大小核对实际节省：转换后总体积与转换前总体积之差应与第 3 步的「预计节省」一致；不一致时停止发布并记录差异。

### 手工验收清单

| 操作 | 期望 |
| --- | --- |
| 在 Canvas 中只通过节点引用一张 PNG，转换该图 | Canvas 节点 `file` 指向新文件，图片仍能显示，复扫无失效链接 |
| 准备一张含透明通道的 PNG，目标选 WebP，分别用「白底」与「跳过」各转换一次 | 白底输出 WebP 且透明区域变白；跳过时原 PNG 保持不动，并提示已跳过 |
| 准备无扩展名 Wiki 嵌入 `![[cover]]` 指向 `cover.png`，转换该 PNG | 嵌入仍能解析到 `cover.jpg`，图片正常显示，复扫无失效图片链接 |
| 在 `A/cover.png` 与 `B/cover.png` 放同名图片，同时转换 | 分别生成 `A/cover.jpg` 与 `B/cover.jpg`，不出现目标冲突跳过 |
| 分别准备带尺寸参数的 Wiki 嵌入、frontmatter 裸路径、`picture/source`、CSS `url()`、Excalidraw 代码块引用 | 估算阶段均标记跳过，原图与引用保持不变 |
| 先放一个同名不同内容的 `cover.jpg`，再转换 `cover.png` | 标记目标文件已存在且内容不同，不覆盖、不改引用 |
| 转换后重新扫描全部 9 类问题 | 失效图片链接与失效笔记链接均为 0，没有新增失效引用 |
| 记录转换前总体积与转换后总体积 | 实际节省与预估一致；不一致时停止发布并记录差异 |
