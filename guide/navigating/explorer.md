---
type: Feature
title: Explorer
description: "The folder tree: titles or filenames, keyboard control, drag and drop, and the Bundle root."
tags: [explorer, tree, keyboard]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Explorer

The Explorer is the folder tree on the left.

- **Titles, not filenames.** Concepts and folders are labelled by their frontmatter `title` (a folder by its `index.md`'s title). A button in the left rail switches back to filenames, remembered per Bundle.
- **Follows you.** The folders leading to the open Concept expand while it's open and fold back when you move elsewhere.
- **Keyboard.** Arrow keys move through the tree, Enter or Space opens a Concept or toggles a folder, and keybindings create, rename and delete the focused item.
- **Drag and drop** moves Concepts and folders. [Links](/editing/links.md) to them are rewritten.
- **Context menu.** Right-click for create, rename, delete, **Set as Bundle Root**, and deleting a folder's `index.md` or `log.md`.

The header shows the Bundle's title, taken from its root `index.md`; click it to open that page. Draft, deprecated and stale Concepts are marked in the tree (see [OKF support](/okf/okf-support.md)).
