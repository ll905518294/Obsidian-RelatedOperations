# Obsidian 插件开发交接说明

> 本文档用于交接给 Codex AI 继续 Obsidian 插件开发工作。

---

## 一、项目目标

开发实用的 Obsidian 社区插件，最终目标是提交到 Obsidian 官方社区插件仓库并上架，供全球用户安装使用。

---

## 二、官方开发者文档（核心依据）

### 2.1 官方文档站点

**所有开发工作必须以官方文档为准：**

- **文档首页**：https://docs.obsidian.md/
- **插件开发入门**：https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin
- **API 参考**：https://docs.obsidian.md/Reference/TypeScript+API
- **插件发布指南**：https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin
- **开发者文档 GitHub 仓库**：https://github.com/obsidianmd/obsidian-developer-docs

### 2.2 官方插件模板仓库

- **仓库地址**：https://github.com/obsidianmd/obsidian-sample-plugin
- **标星数**：4,481 ⭐（截至 2026-08-22）
- **许可证**：BSD Zero Clause License
- **用途**：官方维护的标准模板，包含构建配置、开发最佳实践、GitHub Actions。新项目应基于此模板初始化。

### 2.3 社区插件提交仓库

- **仓库地址**：https://github.com/obsidianmd/obsidian-releases
- **用途**：Obsidian 官方社区插件、主题目录及发布托管仓库。插件上架需在此仓库提交 PR。
- **提交文件**：`community-plugins.json`（插件清单）
- **注意**：该仓库不接受 Issue，问题请在各自插件仓库提出。

---

## 三、开发环境要求

| 工具 | 要求 | 说明 |
|---|---|---|
| Node.js | LTS 版本 | 插件构建运行时 |
| npm | 随 Node.js 安装 | 依赖管理 |
| Git | 最新版 | 版本控制 |
| TypeScript | 项目内依赖 | Obsidian 插件使用 TypeScript 开发 |
| esbuild | 项目内依赖 | 打包构建工具（官方模板默认配置） |
| Obsidian | 最新桌面版 | 本地测试 vault 中调试插件 |

---

## 四、标准项目结构（基于官方模板）

```
obsidian-xxx-plugin/
├── .github/
│   └── workflows/          # GitHub Actions（发布构建等）
├── src/
│   ├── main.ts             # 插件主入口，继承 Plugin 类
│   └── ...                 # 其他模块
├── manifest.json           # 插件清单（ID、名称、版本、描述、作者）
├── versions.json           # 版本兼容信息
├── package.json            # npm 配置与脚本
├── tsconfig.json           # TypeScript 配置
├── esbuild.config.mjs      # esbuild 构建配置
├── styles.css              # 插件样式
└── README.md               # 项目说明
```

### 核心文件说明

- **`manifest.json`**：插件元数据，`id` 必须全局唯一，`version` 遵循语义化版本。
- **`main.ts`**：插件生命周期入口，必须实现 `onload()` 和 `onunload()` 方法。
- **`versions.json`**：记录每个插件版本对应的最低 Obsidian 应用版本要求。

---

## 五、开发工作流

### 5.1 初始化项目

```bash
# 方式一：使用 GitHub "Use this template" 从官方模板创建
# 方式二：命令行克隆
git clone https://github.com/obsidianmd/obsidian-sample-plugin.git obsidian-xxx-plugin
cd obsidian-xxx-plugin
rm -rf .git
git init
npm install
```

### 5.2 本地开发调试

```bash
# 启动开发模式（监听文件变化，自动构建）
npm run dev

# 构建生产版本
npm run build
```

**调试步骤**：
1. 在 Obsidian 中创建一个测试用 vault（不要用日常 vault）
2. 将构建产物（`main.js`、`manifest.json`、`styles.css`）复制到测试 vault 的 `.obsidian/plugins/<plugin-id>/` 目录
3. 在 Obsidian 设置 → 第三方插件中启用插件
4. 使用 `Ctrl+Shift+I` 打开开发者工具调试（Obsidian 基于 Electron）

### 5.3 版本发布

```bash
# 官方模板提供版本号自动更新脚本
npm version patch  # 或 minor / major
```

发布时需要：
- 更新 `manifest.json` 中的 `version`
- 更新 `versions.json`，添加新版本与最低 Obsidian 版本映射
- 打 Git tag（格式：`x.y.z`）
- 推送 tag 触发 GitHub Actions 自动构建发布产物

---

## 六、社区插件上架流程（未来目标）

### 6.1 上架前检查清单

- [ ] `manifest.json` 中 `id` 全局唯一（在社区插件列表中不存在）
- [ ] `name` 清晰描述插件功能
- [ ] `version` 遵循语义化版本（SemVer）
- [ ] `description` 简洁准确
- [ ] `author` 填写正确
- [ ] 插件在最新版 Obsidian 中测试通过
- [ ] README.md 包含功能说明、安装方法、使用截图
- [ ] 代码中无硬编码的个人路径或敏感信息
- [ ] 许可证文件齐全（推荐 MIT）
- [ ] Release 页面已发布对应版本的构建产物（`main.js`、`manifest.json`、`styles.css`）

### 6.2 提交流程

1. Fork [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) 仓库
2. 在 `community-plugins.json` 中添加插件条目：
   ```json
   {
     "id": "your-plugin-id",
     "name": "Your Plugin Name",
     "author": "Your Name",
     "description": "Plugin description",
     "repo": "your-github-username/your-repo-name"
   }
   ```
3. 提交 Pull Request
4. 等待官方审核（审核周期通常数天到数周）
5. 审核通过后，用户可在 Obsidian 内直接搜索安装

### 6.3 后续版本更新

插件上架后，每次新版本发布：
1. 在自己的仓库中更新版本、打 tag、发布 Release
2. **无需**再次向 obsidian-releases 提 PR（Obsidian 会自动从你的仓库拉取新版本）
3. 确保 Release 中包含构建产物文件

---

## 七、关键 API 概念（开发时查阅官方文档）

| 概念 | 说明 | 官方文档路径 |
|---|---|---|
| Plugin 基类 | 所有插件必须继承的类 | Reference/TypeScript API/Plugin |
| 命令注册 | `this.addCommand()` 注册命令面板命令 | Plugins/Reference/Commands |
| 设置面板 | `PluginSettingTab` 类创建设置页 | Plugins/Reference/Settings |
| 模态框 | `Modal` 类创建弹窗 | Plugins/Reference/Modals |
| 侧边栏视图 | `ItemView` + `registerView()` 创建侧边栏 | Plugins/Reference/Views |
| Ribbon 图标 | `this.addRibbonIcon()` 添加左侧栏按钮 | Plugins/Reference/Ribbon |
| 通知 | `new Notice()` 显示临时通知 | Reference/TypeScript API/Notice |
| 文件操作 | `this.app.vault` 访问 vault 文件系统 | Reference/TypeScript API/Vault |
| 事件注册 | `this.registerEvent()` 自动清理的事件监听 | Plugins/Reference/Events |

---

## 八、参考资源

### 8.1 高星参考插件（读源码学习）

| 插件 | ⭐ 标星 | 仓库 |
|---|---|---|
| Tasks | 3,956 | https://github.com/obsidian-tasks-group/obsidian-tasks |

### 8.2 资源汇总

| 项目 | ⭐ 标星 | 说明 |
|---|---|---|
| awesome-obsidian | 9,265 | https://github.com/kmaasrud/awesome-obsidian |
| awesome-obsidian-zh | 737 | https://github.com/PKM-er/awesome-obsidian-zh |

### 8.3 开发工具

| 项目 | ⭐ 标星 | 说明 |
|---|---|---|
| obsidian-tools | 308 | https://github.com/obsidian-tools/obsidian-tools（CLI 工具集） |

---

## 九、当前状态与下一步

### 当前状态

- [x] 完成 Obsidian 插件开发生态调研
- [x] 确认官方模板与文档路径
- [x] 明确社区插件上架流程
- [ ] 确定具体插件功能需求
- [ ] 初始化项目仓库
- [ ] 开发核心功能
- [ ] 本地测试验证
- [ ] 提交社区插件上架

### 待 Codex AI 继续的事项

1. **与用户确认插件功能需求**：明确要开发什么功能的插件，目标用户是谁，解决什么问题。
2. **基于官方模板初始化项目**：使用 `obsidianmd/obsidian-sample-plugin` 作为起点。
3. **严格遵循官方文档**：所有 API 使用、配置规范、发布流程以 https://docs.obsidian.md/ 为准。
4. **为上架做准备**：从第一天起就遵循社区插件规范（唯一 ID、语义化版本、完整 README、许可证）。

---

## 十、注意事项

1. **官方文档优先**：遇到任何 API 用法疑问，先查官方文档，不要依赖非官方教程或 AI 猜测。
2. **Obsidian API 不是开源的**：Obsidian 应用本身不开源，但通过 TypeScript 类型定义（`obsidian` npm 包）提供 API。
3. **向后兼容**：注意 `versions.json` 中声明的最低 Obsidian 版本，使用新 API 时需确认兼容性。
4. **性能意识**：插件运行在用户的 vault 中，避免阻塞主线程，大文件操作使用异步 API。
5. **数据安全**：不要在未经用户同意的情况下上传 vault 数据到外部服务。

---

*文档生成时间：2026-08-22*
*交接对象：Codex AI*
