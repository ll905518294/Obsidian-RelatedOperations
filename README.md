# Related Operations

An Obsidian community plugin for finding and moving notes directly related to the current note.

## Features

- Finds resolved Markdown notes linked from the source note or linking to it.
- Opens from the command palette, ribbon, or a Markdown file's context menu.
- Supports multi-selecting Markdown notes and processing all Markdown notes inside a selected folder.
- Integrates with Notebook Navigator when it is installed, including its multi-selection and folder menus.
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

## Development

```bash
npm install
npm run dev
npm run build
npm run lint
```

The production build writes `main.js` at the plugin root. Install `main.js`, `manifest.json`, and `styles.css` in the vault's `.obsidian/plugins/related-operations/` directory for manual testing.

## Safety behavior

- Only resolved Markdown notes are candidates.
- Existing destination files are skipped; files are never overwritten or auto-renamed.
- Batch failures are reported and do not automatically roll back successful moves.
