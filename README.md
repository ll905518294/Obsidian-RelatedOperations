# Obsidian-Manager

一个用于检查 Vault 健康状况、整理关联笔记和清理未引用资源的 Obsidian 社区插件。

## Features

- Finds resolved Markdown notes linked from the source note or linking to it.
- Opens from the command palette, ribbon, or a Markdown file's context menu.
- Supports multi-selecting Markdown notes and processing all Markdown notes inside a selected folder.
- Integrates with Notebook Navigator when it is installed, including its multi-selection and folder menus.
- Optionally maintains incoming, outgoing, and bidirectional link counts in frontmatter for display in Notebook Navigator.
- Aggregates related notes across all selected source notes and de-duplicates the move list.
- Batch views show the source note beside each related-note row; the same related note may appear for multiple sources but is moved once.
- Opens the cleanup tool as a normal workspace tab on desktop and a modal fallback on mobile.
- Groups notes into outgoing, incoming, and bidirectional tabs with counts.
- Supports cross-tab selection, current-group select-all, and note navigation.
- Selects multiple related notes before moving.
- Defaults the base target folder to the source note's parent folder.
- For a batch, defaults to the parent folder of the first source note by path order.
- Defaults the target folder to the source note's folder plus `Pages`.
- Allows typing a complete target folder path or choosing a shortcut for the current folder, source-note folder, or current folder plus `Pages`.
- Supports one grouping mode at a time: no grouping, grouping by source note, or grouping by current path. Legacy grouping settings are migrated automatically.
- **全选当前分组** only selects the current relation tab; **全选所有可移动笔记** selects deduplicated movable notes across all tabs.
- The **双向链接** tab is the intersection of outgoing and incoming links and must not be added to those counts as an independent category.
- Defaults to grouping rows by source note; grouping by current path and hiding compliant rows can be changed in the panel or plugin settings.
- Shows a confirmation step before any batch move is executed.
- Uses Obsidian's native file manager so link updates follow the user's Obsidian settings.
- Does not hard-depend on Custom Attachment Location. Test with that plugin enabled to verify attachment behavior in the target vault.

## Orphan resource cleanup

Use the left ribbon **打开 Vault 体检与清理** icon or the command with the same name to open the cleanup tool. On desktop it opens as a normal workspace tab; on mobile it falls back to a modal. After scanning, **体检首页** and each cleanup category are sibling tabs, so you can switch back to the overview at any time. Click **开始扫描** to inspect unreferenced images, unreferenced attachments, empty files, and recursively empty folders in separate tabs. Empty files include zero-byte non-image, non-Canvas files and Markdown files containing only YAML frontmatter. Nothing is selected by default; select items, then confirm to move them to Obsidian's local trash.

- Images: the formats configured in **设置 → Obsidian-Manager → 可清理图片格式** that are not referenced by resolved Markdown links or Canvas file nodes. The default is PNG, JPG/JPEG, GIF, WEBP, SVG, BMP, AVIF, and ICO; use commas, spaces, or Chinese commas to separate extensions.
- Ignored folders: configure **设置 → Obsidian-Manager → 忽略目录** with comma-, space-, or line-break-separated paths. A folder and all descendants are excluded from unreferenced-image, unreferenced-attachment, and empty-folder candidates; broken and native image-link checks are unchanged.
- Conservative reference scan: any textual mention of an image file name or path in Markdown content also counts as a reference. This covers HTML image tags, plain-text paths in frontmatter, and code-block text, so images referenced in non-standard ways are never flagged as orphans.
- Broken image links: Markdown image embeds and image links whose local target cannot be resolved are shown in a separate tab. Select occurrences to remove the full link syntax; external URLs, HTML images, frontmatter links, and code-block text are not scanned. This edits Markdown directly and does not use the trash.
- Broken note links: Wiki links and Markdown links targeting missing Markdown notes are shown separately. Titles, block references, aliases, external URLs, images, attachments, frontmatter, and code blocks are handled conservatively. The cleanup window can locate, ignore for the current scan, remove, or create selected missing Markdown targets. Missing parent folders are created; existing files and invalid targets are skipped and reported.
- Native image links: the cleanup window also finds Obsidian image embeds such as `![[image.png]]` across the vault. Select resolved entries and convert them to `![](<path>)`; alt text is intentionally left empty. Dimensions, unresolved targets, code blocks, and frontmatter are skipped and left unchanged. Conversion is grouped per note and can be undone with Obsidian's edit history.
- Preview and grouping: the image list displays a thumbnail; select it to open a larger preview. Use **分组** to show the list by folder path or file extension.
- Folders: folders with no files, including parent folders that only contain empty subfolders. Hidden folders such as `.obsidian`, `.trash`, and `.git` are never scanned, and a folder containing hidden subfolders is not listed as empty.
- Attachments: all non-Markdown, non-Canvas files outside hidden or ignored folders are scanned. Files referenced by resolved links, Canvas nodes, or textual file-name/path mentions are excluded.
- After image cleanup, select **重新扫描** before cleaning folders that have only just become empty.
- Before moving a selected resource to the local trash, the plugin rescans its cleanup status. Resources that were referenced, changed, or removed after the original scan are skipped.
- Reports: **复制报告** copies the current scan to the clipboard; **导出报告** writes a Markdown report such as `related-operations-report-20260829-120000.md` to the vault root. Reports contain paths and link details, not note bodies. The latest batch summary is shown in the result window and is not persisted as a log file.
- Duplicate files: the **重复文件** tab groups non-hidden, non-ignored Markdown, image, and attachment files by exact SHA-256 content hash after a file-size precheck; Canvas files and single-file groups are excluded. Before selected duplicate files are moved to the Obsidian trash, matching links in Markdown notes are removed; a failed note edit prevents deletion. The table supports group selection and shared image previews.

## Link-count properties

The optional setting **写入关联数量到属性** is disabled by default. When enabled, the plugin maintains these frontmatter properties:

- `related-operations-in-links`
- `related-operations-out-links`
- `related-operations-bidirectional-links`

Use the command **刷新全库笔记关系数量** to update all Markdown notes immediately. Automatic updates are debounced, compare the resolved-link cache, and check only edited notes and endpoints of changed links. Files are written only when a value changes. Periodic checks use the same incremental path.

When applying custom property names, the plugin refuses names already used by other frontmatter fields so existing note metadata is not overwritten.

## Development

测试脚本使用 Node.js 22+ 的原生 TypeScript 类型擦除选项；构建插件本身仍以 ES2021 为目标。

```bash
npm install
npm run dev
npm run build
npm run deploy
npm run lint
npm test
```

`npm run build` 只生成项目根目录的构建产物，不会修改 Vault。要让当前打开的 Obsidian 加载最新代码，请运行 `npm run deploy`；它会识别唯一的当前 Vault、复制并校验插件文件，然后重启 Obsidian。部署失败时不会继续重启。

重新安装或更新都使用同一条命令：`npm run deploy`。它会覆盖目标插件文件，不会删除 Vault 笔记或插件数据；旧插件目录会先保存为同级的 `.backup`。如需先确认目标 Vault 和安装状态，运行 `npm run deploy:check`，该命令只构建并检查，不复制文件、不重启 Obsidian。

## 本地一键部署测试

构建完成后双击项目根目录的 `deploy-and-restart.cmd`，或运行 `npm run deploy`。脚本会自动识别当前打开的 Vault，构建并替换 `Obsidian-RelatedOperations` 插件，校验部署文件哈希，然后调用 Obsidian CLI 的 `restart` 命令重启应用并等待稳定运行，从而清理旧插件代码并加载最新状态；同时保留最近一次 `.backup`。没有唯一的当前 Vault、构建失败、文件校验失败或 Obsidian 无法稳定重启时，脚本会停止且不继续部署。

The production build writes `main.js` at the plugin root. Install `main.js`, `manifest.json`, and `styles.css` in the vault's `.obsidian/plugins/Obsidian-RelatedOperations/` directory for manual testing.

## Safety behavior

- Only resolved Markdown notes are candidates.
- Existing destination files are skipped; files are never overwritten or auto-renamed.
- Batch failures are reported and do not automatically roll back successful moves.
