---
type: Concept
title: Activity Rail and Concept header — where the controls live
description: The two control surfaces that replaced the deleted global nav bar — the far-left Activity Rail for application-global controls, and the per-Tile Concept header for concept-scoped controls.
tags: [interface, activity-rail, concept-header, toolbar, chrome]
timestamp: 2026-07-23
---

# Activity Rail and Concept header

Sunstone has **no global nav bar**. The controls once collected in a single app
header are now split by scope across two surfaces: the **Activity Rail** holds
what is global to the whole app, and each Tile's **Concept header** holds what is
scoped to the open Concept. The rule is the same one the old header only
gestured at — *global controls and concept controls never share a bar* — now
enforced by giving each its own home.

## Activity Rail

The **Activity Rail** (`ActivityRail.svelte`, aria-label "Activity rail") is a
thin, always-visible vertical icon strip on the far-left edge of the [app
shell](/interface/app-shell.md). It sits **outside** the collapsible left
[Sidebar](/interface/sidebars.md), so it stays visible even when that Sidebar is
collapsed. It holds only application-global controls — nothing scoped to a
single Concept or Tile:

| Control | Position | Does |
| ------- | -------- | ---- |
| Menu | top | App menu — a stub today (no contents yet) |
| Quick nav | top | Open [Quick nav](/GLOSSARY.md) (`Ctrl`/`Cmd`+`K`) |
| Search | top | Open [Search](/GLOSSARY.md) (`Ctrl+Shift+F`) |
| User slot | bottom | Reserved; empty on desktop, filled on the web anon surface with the Auth.js sign-in / sign-out affordance |

The Rail is presentational: its buttons flip the **same** overlay-open flags the
`Ctrl+K` / `Ctrl+Shift+F` keybindings flip, so button and keyboard converge on
one code path.

## Concept header

The **Concept header** (`TileHeader.svelte`) is the per-[Tile](/editor/editor-layout.md)
control bar above each open Concept. It carries every control scoped to *that*
Tile's Concept:

| Control | Does |
| ------- | ---- |
| Back / forward | Move through the Tile's own navigation history |
| **Edit** toggle | Switch the Tile between `read` and `editing` — the boolean view mode (see [ADR 0001](/adr/0001-codemirror-hybrid-live-preview.md)) |
| Properties toggle | Show/hide inline frontmatter chrome (drives the app-wide `propertiesShown` flag) |
| Undo / redo | Over the Tile's Document history — **shown only while editing** |
| Review | Toggle the working-tree ↔ HEAD diff |
| Export PDF | Export the Concept |
| Split | Split Right (new Column) / Split Down (new Tile in this Column) |
| Close | Clear the Tile (shown only when more than one Tile is on screen) |

A single open Concept therefore shows just its Concept header — there is no
second global bar above it. The **Edit** toggle is the sole view-mode control:
the old tri-state Source / Live / Reading segmented control is gone, undo/redo
appear here only in `editing` mode, and a Concept **opens in `read`**.

The Properties toggle drives one app-wide flag (`propertiesShown`): on, every
visible Tile renders its own Concept's frontmatter inline; off, no Tile shows any
Properties chrome. Its scope is unchanged from the old header — only its home
moved.

## On the web

Both surfaces carry over to the web build (see [app shell → web
surfaces](/interface/app-shell.md)):

- The **authenticated** surface mounts the full desktop `App.svelte` shell, so it
  inherits the Activity Rail and Concept header unchanged (with the web write
  path — explicit Save, concurrency gate).
- The **anonymous** read-only SSR surface renders the same Activity Rail — with a
  live **Quick nav** and **Search** island and a rail **Sign in** affordance —
  but replaces the full Concept header with a **slim concept strip** over the
  centre: back/forward, the Properties toggle, export-PDF and a light/dark theme
  toggle. There is no Edit toggle until you sign in.

## Relationships

- Both surfaces live in the [app shell](/interface/app-shell.md); the Rail flanks
  the left [Sidebar](/interface/sidebars.md), the Concept header tops each
  [Tile](/editor/editor-layout.md).
- The Edit toggle's `editing`/`read` boolean is specified in
  [ADR 0001](/adr/0001-codemirror-hybrid-live-preview.md); the Properties flag is
  [View state](/interface/view-state.md).
- **Activity Rail**, **Concept header**, **Quick nav** and **Search** are indexed
  in the [glossary](/GLOSSARY.md).
