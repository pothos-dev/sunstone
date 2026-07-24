---
type: Concept
title: Editor layout — the tiling model
description: How the Editor pane tiles Concepts into a grid of Columns and Tiles, with a single active Tile over a shared buffer.
tags: [editor, tiling, layout, tile, column]
timestamp: 2026-07-22
---

# Editor layout

The **Editor pane** is the central [Pane](/GLOSSARY.md) of the app shell. It is
a **grid of Tiles arranged in Columns**: a horizontal row of Columns, each a
vertical stack of Tiles. Before tiling existed the pane showed a single open
Concept; that is now just the one-Tile case.

## Columns and Tiles

- A **Column** is a vertical stack of **Tiles**; the Editor pane is a row of
  Columns.
- A **Tile** is one editor cell, showing a single open **Concept** with its own
  view-mode (the `editing`/`read` boolean — default `read`), scroll position and
  navigation history, topped by its own **Concept header** (the per-Tile control
  bar — see [Activity Rail and Concept header](/interface/activity-rail.md)).
- Columns and the Tiles within them are **independently resizable** via
  draggable dividers, and rows need not align across Columns.

The **Concept header** carries every concept-scoped control — back/forward, the
**Edit** toggle (which flips the Tile between `read` and `editing`), the
Properties toggle, undo/redo (only while editing), review, export-PDF, split and
close. There is no global nav bar; app-global controls live on the
[Activity Rail](/interface/activity-rail.md) instead.

`Split Right` / `Split Down` are the actions that create a new Column / Tile;
"split" is never the noun (the Column and Tile are the nouns).

## The active Tile and shared buffers

Exactly one Tile is the **active Tile** — the focused editor cell. The
[Outline, Backlinks and Properties](/GLOSSARY.md) all describe the active Tile.

The same Concept may be open in **multiple Tiles at once**, and they share **one
underlying buffer**: edits and autosave in one Tile are reflected in the others.
This is the Document/Pane split — a *Document* owns a Concept's buffer, dirty
flag, autosave and disk IO (addressable by path via a registry); a view onto it
owns the active Concept, navigation history and view state and attaches to a
Document. Two views onto the same path share one live Document.

Each Tile hosts a CodeMirror `EditorView` built by the
[CodeMirror integration](/editor/codemirror.md); the multi-Tile shared buffer is
what its minimal-change reload path keeps caret-stable.

## How the code models a Tile

The code splits a Tile into two 1:1 representations, addressed by a shared id:

- **`Tile`** (`workspace.svelte.ts`) — the stateful cell: its active Concept,
  navigation history and view-mode. It attaches to a `Document` (the
  buffer/autosave layer), so two Tiles on the same path share one live buffer.
- **`TileSlot`** (`tileLayout.ts`) — the geometry node in the layout tree: an id
  plus a weight (its share of the column). The pure size math lives here.

The word **Pane** is reserved in code for the domain sense (a top-level app-shell
region), matching the [glossary](/GLOSSARY.md).

## Relationships

- The **Editor pane** hosts a row of **Columns**; each Column stacks **Tiles**.
- The Editor pane *is* the **Editor** Region — keyboard focus and Region
  movement are described in the [focus model](/interface/focus-model.md).
- Terms are indexed in the [glossary](/GLOSSARY.md).
