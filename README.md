# Related Operations

An Obsidian community plugin for finding and moving notes directly related to the current note.

## Features

- Finds resolved Markdown notes linked from the source note or linking to it.
- Opens from the command palette, ribbon, or a Markdown file's context menu.
- Supports multi-selecting Markdown notes and processing all Markdown notes inside a selected folder.
- Integrates with Notebook Navigator when it is installed, including its multi-selection and folder menus.
- Optionally maintains incoming, outgoing, and bidirectional link counts in frontmatter for display in Notebook Navigator.
- Aggregates related notes across all selected source notes and de-duplicates the move list.
- Batch views show the source note beside each related-note row; the same related note may appear for multiple sources but is moved once.
- Uses a movable standalone popout window on desktop and a modal fallback on mobile.
- Groups notes into outgoing, incoming, and bidirectional tabs with counts.
- Supports cross-tab selection, current-group select-all, and note navigation.
- Selects multiple related notes before moving.
- Defaults the base target folder to the source note's parent folder.
- For a batch, defaults to the parent folder of the first source note by path order.
- Defaults the subfolder to `Pages`; it can be cleared, replaced, or extended with nested paths.
- Allows choosing or typing a base folder and an optional nested subfolder.
- Defaults to grouping rows by source note; grouping by current path and hiding compliant rows can be changed in the panel or plugin settings.
- Shows a confirmation step before any batch move is executed.
- Uses Obsidian's native file manager so link updates follow the user's Obsidian settings.
- Does not hard-depend on Custom Attachment Location. Test with that plugin enabled to verify attachment behavior in the target vault.

## Orphan resource cleanup

Use the left ribbon **扫描并清理孤立资源** icon or the command with the same name to open the cleanup window. On desktop it opens in a movable standalone window; on mobile, or when a standalone window cannot be created, it falls back to a modal. The window automatically scans and shows orphaned images and recursively empty folders in separate tabs. Nothing is selected by default; select items, then confirm to move them to Obsidian's local trash.

- Images: the formats configured in **设置 → Related Operations → 可清理图片格式** that are not referenced by resolved Markdown links or Canvas file nodes. The default is PNG, JPG/JPEG, GIF, WEBP, SVG, BMP, AVIF, and ICO; use commas, spaces, or Chinese commas to separate extensions.
- Preview and grouping: the image list displays a thumbnail; select it to open a larger preview. Use **分组** to show the list by folder path or file extension.
- Folders: folders with no files, including parent folders that only contain empty subfolders.
- Not scanned: non-image attachments, HTML image tags, plain-text paths in frontmatter, and code-block text.
- After image cleanup, select **重新扫描** before cleaning folders that have only just become empty.

## Link-count properties

The optional setting **写入关联数量到属性** is disabled by default. When enabled, the plugin maintains these frontmatter properties:

- `related-operations-in-links`
- `related-operations-out-links`
- `related-operations-bidirectional-links`

Use the command **刷新全库关联数量属性** to update all Markdown notes immediately. Automatic updates are debounced and only write files when a value changes.

## Development

```bash
npm install
npm run dev
npm run build
npm run lint
npm test
```

## 本地一键部署测试

构建完成后双击项目根目录的 `deploy-and-restart.cmd`。脚本会自动识别当前打开的 Vault，构建并替换 `Obsidian-RelatedOperations` 插件，保留最近一次 `.backup`，然后优雅重启 Obsidian。没有唯一的当前 Vault、构建失败或 Obsidian 无法正常退出时，脚本会停止且不继续部署。

The production build writes `main.js` at the plugin root. Install `main.js`, `manifest.json`, and `styles.css` in the vault's `.obsidian/plugins/Obsidian-RelatedOperations/` directory for manual testing.

## Safety behavior

- Only resolved Markdown notes are candidates.
- Existing destination files are skipped; files are never overwritten or auto-renamed.
- Batch failures are reported and do not automatically roll back successful moves.
