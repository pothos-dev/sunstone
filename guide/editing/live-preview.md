---
type: Feature
title: Live preview
description: "Source, Live and Read modes, formatting shortcuts and in-file find and replace."
tags: [editor, shortcuts]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Live preview

The editor works like Obsidian's live preview: lines you are not editing render styled, and the line under the cursor shows its raw markdown. Code is highlighted, task lists are clickable, and GFM tables are interactive.

## View modes

A three-way toggle switches between:

- **Source** – the raw markdown.
- **Live** – hybrid editing, as described above.
- **Read** – the rendered page, with a comfortable line length.

The mode is remembered across restarts.

## Formatting

| Shortcut | Effect |
|----------|--------|
| Ctrl/Cmd+B | Bold |
| Ctrl/Cmd+I | Italic |
| Ctrl/Cmd+E | Inline code |
| Ctrl/Cmd+Shift+M | Strikethrough |
| Ctrl/Cmd+1 … 6 | Heading level 1–6 |
| Ctrl/Cmd+0 | Paragraph |

All of them toggle. Right-clicking in the editor opens a menu with the same actions, plus cut, copy, paste and [comments](/editing/comments.md). In the preview, `--` and `---` render as en and em dashes.

## Find and replace

In-Concept find and replace scrolls each match into view as you step through results.

## Zoom

**Ctrl +** and **Ctrl −** zoom the whole interface, **Ctrl+0** resets it, and Ctrl+mouse wheel works too. A +/− button at the bottom of the right rail does the same.

## Saving

Changes are saved automatically. Closing the app saves any pending change first. When a file changes on disk (for example after a `git pull`), Sunstone picks it up live.
