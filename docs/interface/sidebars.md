---
type: Concept
title: Sidebars and Sections
description: The left and right Sidebars, their collapsible Sections and Accordion height-sharing, and how a collapsed Section is transiently revealed by keyboard focus.
tags: [interface, sidebar, section, accordion, navigation]
timestamp: 2026-07-23
---

# Sidebars and Sections

A **Sidebar** is a [Pane](/GLOSSARY.md) docked to the left or right of the [app shell](/interface/app-shell.md) (inboard of that side's [Activity Rail](/interface/activity-rail.md)), holding a vertical stack of **Sections**. A **Section** is one collapsible item — an always-visible header plus a toggleable body. This is deliberately conventional editor chrome (VSCode-style); the section headers are discoverability affordances, not domain language.

## The two Sidebars

| Sidebar | Sections | Fresh-Bundle default |
| ------- | -------- | -------------------- |
| Left | **Explorer** (the Bundle tree), **Tags** (tags across the Bundle) | expanded; Explorer open, Tags collapsed |
| Right | **Outline** (open Concept's headings), **Backlinks** (Concepts linking here) | collapsed entirely |

The **Tags** Section is hidden *entirely* when the Bundle carries no tags. The **Outline** is derived live from the active Tile's body (frontmatter and fenced code excluded); selecting a heading scrolls the Editor pane to it. **Backlinks** and **Tags** are index-backed read queries; on the web build they are served read-only from the core in-memory index.

## Accordion height-sharing

The **Accordion** names the behaviour of a Sidebar's stacked Sections sharing the viewport: each expanded Section's body is capped so several can be open at once without one starving the rest. It names the *behaviour*, not a single item — one item is always a **Section**.

## Two levels of collapse

Collapse is tracked at two granularities, each with its own persisted flag (see [view state](/interface/view-state.md)):

- **Whole Sidebar** — `leftSidebarOpen`, `rightSidebarOpen`. A collapsed Sidebar hides all its Sections and hands its full width to the Editor pane.
- **Per Section** — `explorerOpen`, `tagsOpen`, `outlineOpen`, `backlinksOpen`. Toggled by the Section header chevron.

A Section is only actually shown when its Sidebar is expanded *and* its own flag is open.

## Collapsing (the rail toggle) and resizing (the edge)

The two gestures live on two different affordances, each doing exactly one thing:

- **Collapse / expand** — the toggle button pinned to the **top of the Sidebar's own [Activity Rail](/interface/activity-rail.md)** (left rail for the left Sidebar, right rail for the right one). Its panel glyph is filled while the Sidebar is shown and hollow while it is hidden, and it carries `aria-pressed` plus a Collapse/Expand label. A collapsed Sidebar goes to a literal **0 width** and its edge is removed with it — the rail is always visible, so the toggle is the way back.
- **Resize** — the Sidebar's inner border, rendered by `SidebarEdge.svelte` over the pure geometry in `sidebarResize.ts`, present only while the Sidebar is expanded. Drag it to resize; Arrow keys resize a focused edge in `KEYBOARD_RESIZE_STEP` steps. It is a `separator`, not a button: clicking it does nothing and it takes no hover highlight.

A Sidebar's width is clamped to `[MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH]` (a corrupt persisted value falls back to `DEFAULT_SIDEBAR_WIDTH`, so a bad store can never wedge the layout) and is remembered as [View state](/interface/view-state.md) — `leftSidebarWidth` / `rightSidebarWidth` on desktop (session store + Rust config), and via `localStorage` on the web anonymous surface (`src/lib/web/uiState.ts`).

## Transient reveal

A Section (or a whole Sidebar) hidden only by a *collapse* is **present but not visible** — its content still exists. When directional [focus](/interface/focus-model.md) moves *into* such a Region, the shell flips a matching **ephemeral reveal flag** (`leftSidebarRevealed`, `explorerRevealed`, …) so the collapsible renders open and focus can land inside. On focus truly leaving, the flag clears and the UI snaps back to the persisted `*Open` state.

- Effective visibility is therefore `*Open || *Revealed`.
- Reveal flags are keyed at the **same granularity** as the persisted ones (each Sidebar, each Section), so a reveal opens exactly the level that was hidden.
- Reveal flags are **never persisted** — a Region stays open after a visit only if it was manually opened *before* the visit.

## Relationships

- Both Sidebars are Panes of the [app shell](/interface/app-shell.md), flanking the [Editor pane](/editor/editor-layout.md).
- Each Section is a focusable [Region](/interface/focus-model.md); reveal is how the focus model reaches a collapsed one.
- Collapse flags are persisted per-user via [view state](/interface/view-state.md).
- Terms (Sidebar, Section, Accordion, Outline) are indexed in the [glossary](/GLOSSARY.md).
