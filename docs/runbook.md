# RUNBOOK

## 1. 本地启动
- 环境：Node.js 22+（`package.json` 的 `engines` 要求 `>=22`；测试脚本使用原生 TypeScript 类型擦除选项）。
- 安装：`npm install`
- 开发监听：`npm run dev`

## 2. 构建与测试
- 生产构建：`npm run build`
- 单元测试：`npm test`
- 静态检查：`npm run lint`
- 打包安装包：`npm run package`（产出 `dist/vault-doctor-<版本号>.zip`）
- 打包预检：`npm run package:check`（只校验输入与打包规则，不写文件）
- 发布说明预检：`node scripts/release-notes.mjs --check`（校验 `CHANGELOG.md` 存在当前版本条目）
- 发版前校验：`npm run release:check`（默认读 `manifest.json`，也可传 tag/版本号；版本、发布说明与内置更新说明一次校验）
- 部署脚本测试：`npm run test:deploy`
- 部署预检：`npm run deploy:check`（只构建和检查，不复制、不重启）
- 部署并重启：`npm run deploy`（失败时默认恢复到备份；加 `-NoRollbackOnFail` 可保留新文件用于排查）
- 产物：项目根目录的 `main.js`，以及 `manifest.json`、可选 `styles.css`；`npm run package` 再产出 `dist/vault-doctor-<版本号>.zip`（`dist/` 已被 `.gitignore` 忽略）。
- 打包脚本为 `scripts/package-plugin.mjs`：零第三方依赖（`node:zlib` + 手工写 ZIP 中央目录），ZIP 内只含根层的三件套，文件名取自 `manifest.json` 的 `id` 与 `version`；打包前校验 `manifest.json` 的 id/SemVer/minAppVersion，并在 `package.json`、`versions.json` 存在时要求版本与映射一致；写出后会重新解压校验条目、大小、CRC-32 与包内 `manifest.json` 版本号。`main.js` 缺失时报错并提示先执行 `npm run build`，不会自动构建。
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

### 版本号 bump 标准顺序

1. 从干净工作区开始（先处理或暂存无关改动），在项目根目录执行：

   ```powershell
   npm version <版本号> --no-git-tag-version
   ```

   该命令会更新 `package.json` 与 `package-lock.json`，并触发 `package.json` 的 `version` 脚本（`node version-bump.mjs`）同步 `manifest.json` 与 `versions.json`。本机 npm 11.11.1 实测 `npm_package_version` 为新版本；`--no-git-tag-version` 下即使工作区有未提交改动也能执行，但干净基线仍是推荐前提，可避免把无关改动混进版本提交。若所用 npm 版本在脏工作区拒绝执行，先提交或暂存无关改动，再按同一顺序 bump。`version` 脚本会把 `package.json`、`package-lock.json`、`manifest.json`、`versions.json` 四份版本文件一起 `git add`；提交前用 `git status` 核对，避免把无关改动一起带入。
2. 再编辑 `CHANGELOG.md` 与 `src/update-intro-content.ts`，加入同一版本的发布说明与内置更新说明。
3. 最后执行 `npm run release:check`，确认四处版本与发布说明一致。

之所以先 bump 再改文档：`npm version` 会运行 `version` 脚本并改写 `manifest.json`/`versions.json`；先完成版本文件同步，再写 CHANGELOG 与内置说明，`release:check` 校验的才是同一次版本变更，不会出现「文档已写、版本文件还没同步」的中间态。

逐项勾选（全部通过后再推送 tag）：

- [ ] **必须**先执行 `npm run release:check`（也可用 `npm run release:check -- 1.9.4` 指定 tag/版本）。它会一次校验 `manifest.json`、`package.json`、`package-lock.json` 根版本、`versions.json` 映射、tag 一致性、CHANGELOG/发布说明、`src/update-intro-content.ts` 内置说明，以及 id/version/minAppVersion 格式；任一项失败都会列出原因并非零退出。
- [ ] 版本号为 SemVer 且无 `v` 前缀（如 `1.0.1`）。
- [ ] `versions.json` 已把 `$v` 映射到 `manifest.json` 的 `minAppVersion`。
- [ ] 提交版本变更前核对 `git status --short`：`manifest.json`、`package.json`、`package-lock.json`、`versions.json` 四份版本文件与 `CHANGELOG.md`、`src/update-intro-content.ts` 同批提交，确认没有把无关改动一起暂存。
- [ ] `npm run build` 通过，项目根生成了最新 `main.js`。
- [ ] `npm run lint` 通过。
- [ ] `npm test` 通过（原生测试全部绿）。
- [ ] `node scripts/release-notes.mjs --check` 通过（可单独确认能生成正文；发布闸门以 `release:check` 为准——正文必须来自 `CHANGELOG.md` 的当前版本条目，条目缺失会直接失败，不会回退为提交记录）。
- [ ] 本次包含图片压缩时，按第 9 节在演示库完成验证。
- [ ] `npm run test:deploy` 与 `npm run deploy:check` 通过（两者都不复制文件、不重启 Obsidian；部署脚本会在构建前校验 `manifest.json`、`package.json`、`versions.json` 的版本一致性）。
- [ ] 三件套存在：`Get-Item main.js, manifest.json, styles.css`。
- [ ] **必须**在打 tag 前执行 `npm run package`：脚本会交叉校验 `manifest.json`、`package.json` 与 `versions.json`，任一版本或映射不一致就失败；`dist/<id>-$v.zip` 存在（文件名取自 manifest 的 id 与 version），且包内 `manifest.json` 的 `version` 与仓库根 `manifest.json` 完全一致（读取 ZIP 内文件比对，不能只看文件名）。连续打包两次的 SHA-256 应相同；ZIP 内三个条目要与仓库根的三件套逐字节一致。
- [ ] tag 与版本一致：`git tag --list $v`（应显示 `$v`），用 `git push origin $v` 推送。
- [ ] 发布后核对：`gh release view $v --json tagName,name,body,assets`，确认 `assets` 包含 `main.js`、`manifest.json`、`styles.css`（若存在）与 `<id>-$v.zip`。
- [ ] 发布后核对：`gh release view $v --json isDraft,isPrerelease` 两项均为 `false`；市场侧按第 7.3 节处理，后续版本不需要重新提交「New plugin」表单。
- [ ] 可选：`Get-FileHash main.js, manifest.json, styles.css, dist/<id>-$v.zip -Algorithm SHA256`，与 release 正文中的 SHA-256 对照。

发布后 release workflow 会调用 `scripts/release-check.mjs` 复核版本、发布说明与内置更新说明，运行 `npm run lint`、`npm test` 与 `npm run package`，并复检 ZIP 内 `manifest.json` 的版本；release 正文由 `scripts/release-notes.mjs` 从 `CHANGELOG.md` 提取当前版本条目（缺失时 `release:check` 直接失败，不会回退为 tag 提交记录），再追加版本、最低 Obsidian 版本与资产 SHA-256。通过后把 ZIP 与三件套一起附到 release。

workflow 可安全重跑：Release 已存在时不再调用 `gh release create`，而是用 `gh release edit` 更新标题与正文，并用 `gh release upload --clobber` 覆盖同名资产；Release 不存在时才创建。tag 重推或 Actions 失败后重跑同一 workflow 都不会因「Release 已存在」卡住。Verify 阶段会断言正文非空且包含 `## 更新说明`，缺失即失败。

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

## 7. 社区目录状态与维护（当前 1.9.7）

插件已于 2026-11-17 上架 Obsidian 社区市场：<https://community.obsidian.md/plugins/vault-doctor>。首次提交通过 <https://community.obsidian.md/> 网页表单完成（`obsidianmd/obsidian-releases` 的 Issue/PR 通道已关闭）；7.1 与 7.2 是提交时的核对记录，保留供后续审核参考。

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
| `id` 全目录唯一且不含 `obsidian`（Submit guide） | 已收录于社区目录；id 不含 `obsidian` | 满足 |
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
| 存在 tag 与 `manifest.version` 一致的正式 release（Submit guide / README） | 已上架；最新正式 release 为 `1.9.6`（2026-11-17），tag 与 `manifest.json` 一致；1.9.7 发布后更新 | 满足 |

### 7.3 后续版本维护

首次提交已完成，后续版本不需要重新提交「New plugin」：

1. 按第 4 节升版本、写 CHANGELOG、补内置更新说明，并发布与 tag 完全一致的正式 release。
2. 社区目录会在镜像时读取默认分支 HEAD 的 `manifest.json` 与对应 tag；release 必须存在且 tag 与版本一致。
3. 若市场审核要求修正，递增版本重新发布，不要改写已发布 tag 的版本号。
4. 需要公告时可在 Obsidian 论坛 Share & showcase 与 Discord `#updates` 发帖。

## 8. 截图与 README 一致性维护

README 的截图位于 `docs/images/`（`00-installed.png` 至 `10-image-convert-result.png`）。当前截图状态（对照 1.9.7）：

- **已用演示库实拍替换（6 张，无缺口）**：通过 Obsidian CDP 在纯合成演示库 `vault-doctor-demo` 实拍，1920×1032，深色 Border 主题，9 分类齐全（含「Wiki 笔记链接」页签），内容全为虚构示例数据，不含任何真实项目/客户/公司名。
  - `01-dashboard.png`：体检首页 · 扫描前 `0/9`
  - `02-scan-result.png`：扫描完成 `9/9`
  - `03-unused-images.png`：未引用图片 2 张
  - `04-broken-links.png`：失效笔记链接 1 条
  - `05-empty-files.png`：空文件 2 个
  - `06-duplicate-files.png`：重复文件 1 组
- **无需更新**：`07-related-notes.png`（关联笔记整理）与 `08-settings.png`（插件设置）与当前实现一致。
- `00-installed.png`（已安装插件列表与 **⋯** 操作菜单）只用于安装说明，本轮未单独核对它与 1.9.7 界面的一致性。
- **1.8.0 新增（2 张，已过时）**：`09-image-convert.png`（图片压缩页签：候选列表与汇总条）与 `10-image-convert-result.png`（压缩完成后的结果与提示）。两张图均拍摄于 1.9.4 之前，画面仍含「此页会修改文件」横幅、质量滑块与底部动作栏，也未体现 1.9.7 的「图片压缩」改名、按钮整合与单入口；当前 README 描述已按 1.9.7 更新，截图需按 8.1 重拍。

更新截图时保持文件名不变，避免改动 README 引用；不要用真实 Vault 截图（会暴露私有内容），统一使用演示库实拍，并保持 9 个分类页签与「图片压缩」页签齐全。

`01-dashboard.png`、`02-scan-result.png` 仍是含 9 分类的旧取景，未包含末尾的「图片压缩」页签；图片压缩改由 `09`、`10` 两张单独说明，不要求首页截图滚动到标签条末尾。

### 8.1 09/10 截图重拍（1.9.7 布局）

安全约束（必须全部满足，缺一不可）：

1. 只在演示库 `vault-doctor-demo` 的**临时副本**中操作：先把整个演示库复制到系统临时目录，再用 Obsidian 打开副本；不要直接打开正式演示库或任何真实 Vault。
2. 副本启动后，先在开发者控制台执行 `app.vault.adapter.basePath`，确认返回值指向临时副本目录（路径包含副本目录名）。若指向正式演示库、真实库或无法确认，立即停止，不得继续转换。
3. **禁止在真实库或正式演示库点击「开始转换」「全选可节省项」等会改写文件的操作**；转换只允许发生在临时副本。拍摄完成后恢复 `obsidian.json` 并重启回真实库。
4. 拍摄只截取 Obsidian 窗口内容，不包含桌面、其他应用、账号信息或真实文件路径。

拍摄步骤：

1. 复制 `vault-doctor-demo` 到临时目录，并在副本中补一张合成噪声 PNG 作为「可节省」素材；素材文件名与引用不得包含真实项目、客户或公司信息。
2. 打开副本，进入 **体检与清理 → 图片压缩**，源格式只勾选 PNG，目标格式 JPG，质量 85，透明图处理选白底。
3. 点**扫描并估算**，等进度结束；截取 `09-image-convert.png`。画面应包含顶部单一操作卡（操作栏、源格式、目标格式/质量/透明图、汇总）与候选表格，不得出现底部动作栏或「此页会修改文件」横幅。
4. 点**全选可节省项** → 连点两次**开始转换** → 等转换完成；截取 `10-image-convert-result.png`。画面应包含表格下方的「最近一次转换」结果摘要与右上角完成提示。
5. 保持文件名不变，覆盖 `docs/images/09-image-convert.png` 与 `docs/images/10-image-convert-result.png`，不新增 README 引用路径。

验收标准：

- 尺寸为 1920×1032，与现有 `00`–`08` 一致；深色 Border 主题。
- 9 个分类页签与「图片压缩」页签齐全（含「Wiki 笔记链接」），库名只显示 `vault-doctor-demo`。
- 画面无真实项目/客户/公司名，无真实用户目录或账号信息。
- 两张图均为 1.9.7 新布局：页签名与卡片名使用「图片压缩」；无「此页会修改文件」横幅、无质量滑块、无底部动作栏；质量显示为数字输入框，常用操作在顶部或「更多」按钮组。

## 9. 图片压缩验证

图片压缩（原图片转换）在 1.7.0 引入。当前 `manifest.json` 为 `1.9.7`，`versions.json` 映射为 `"1.9.7": "1.13.0"`。发布前用演示库 `vault-doctor-demo` 验证图片压缩：

1. 准备同一张 PNG 的三处引用：Wiki 嵌入（含别名、不含尺寸参数）、标准 Markdown 图片链接、HTML `<img src>`；确认三篇笔记都指向该 PNG。
2. 打开 **体检与清理 → 图片压缩**，源格式只勾选 PNG，目标格式选 JPG，质量 85，透明图处理选白底。
3. 记录列表显示的候选数、当前体积、转换后体积与预计节省。
4. 执行转换，确认三处引用都改为 `.jpg`：Wiki 嵌入保留别名，Markdown 链接保留标题与 URL 编码，HTML 的 `src` 同步更新。
5. 重新扫描全部 9 类问题，确认失效图片链接与失效笔记链接均为 0，且没有新增失效引用。
6. 用文件大小核对实际节省：转换后总体积与转换前总体积之差应与第 3 步的「预计节省」一致；不一致时停止发布并记录差异。

### 手工验收清单

| 操作 | 期望 |
| --- | --- |
| 在 Canvas 中只通过节点引用一张 PNG，转换该图 | Canvas 节点 `file` 指向新文件，图片仍能显示，复扫无失效链接 |
| 准备一张含透明通道的 PNG，分别用「白底」与「跳过」各转换一次，目标格式 JPG 与 WebP 各验一遍 | 「白底」时输出铺白底且透明区域变白；「跳过」时原 PNG 保持不动并提示已跳过；两种目标格式行为一致，不因目标是 JPG 就改走白底 |
| 准备无扩展名 Wiki 嵌入 `![[cover]]` 指向 `cover.png`，转换该 PNG | 嵌入仍能解析到 `cover.jpg`，图片正常显示，复扫无失效图片链接 |
| 在 `A/cover.png` 与 `B/cover.png` 放同名图片，同时转换 | 分别生成 `A/cover.jpg` 与 `B/cover.jpg`，不出现目标冲突跳过 |
| 分别准备带尺寸参数的 Wiki 嵌入、frontmatter 裸路径、`picture/source`、CSS `url()`、Excalidraw 代码块引用 | 估算阶段均标记跳过，原图与引用保持不变 |
| 先放一个同名不同内容的 `cover.jpg`，再转换 `cover.png` | 标记目标文件已存在且内容不同，不覆盖、不改引用 |
| 转换后重新扫描全部 9 类问题 | 失效图片链接与失效笔记链接均为 0，没有新增失效引用 |
| 记录转换前总体积与转换后总体积 | 实际节省与预估一致；不一致时停止发布并记录差异 |
