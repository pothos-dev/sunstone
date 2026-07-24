---
type: Concept
title: View state — persisted per-user UI state
description: The per-user UI state Sunstone restores on relaunch — last-open Concept, expanded folders, sidebar flags, tiling layout, window geometry — held per user and never written into the Bundle.
tags: [interface, persistence, view-state, session]
timestamp: 2026-07-23
---

# View state

**View state** is the per-user UI state Sunstone restores when you reopen a Bundle: which Concept was open, which tree folders were expanded, which [Sidebars](/interface/sidebars.md) and Sections were collapsed, the editor view-mode, the tiling [layout](/editor/editor-layout.md), and the window geometry. It is **held per user and never written into the Bundle** — the Bundle is the git-committed content ([Bundle](/okf/bundle.md)); View state is not part of it. This is the OKF "no `.obsidian` equivalent" rule.

> **Naming.** The code still calls this `BundleState` / `saveBundleState` / `loadBundleState` / `/api/bundle-state`, named after the Bundle even though it is *not* Bundle content. The [glossary](/GLOSSARY.md) resolves the term to **View state**; the code rename is a later slice.

## Where it is stored

| Build | Store | Backend method |
| ----- | ----- | -------------- |
| Desktop (Tauri) | OS config dir — `dirs::config_dir()/sunstone/state.json` (e.g. `~/.config/sunstone/state.json`) | `loadBundleState` / `saveBundleState` (`crates/sunstone-core/src/config.rs`) |
| Web | The browser — one `localStorage` key `sunstone:webUI` (`src/lib/web/uiState.ts`) | `saveBundleState` is a **no-op** server-side; state is a client-only concern |

On desktop the store is a single JSON file holding app-level config plus a map keyed by each Bundle's **absolute path** — so every Bundle restores its own state. Window geometry is **owned by Rust** (it manages the window APIs) and round-trips as an opaque `window` field the frontend never inspects.

## What is persisted

The desktop `BundleState` (session store `src/lib/state/session.svelte.ts`) carries:

- `lastOpenConcept` — bundle-relative path reopened on launch.
- `expandedFolders` — expanded Explorer tree folders.
- `recentFiles` — most-recent-first, deduped, capped at 15; feeds the quick-nav palette.
- `leftSidebarOpen`, `rightSidebarOpen` — whole-Sidebar collapse.
- `leftSidebarWidth`, `rightSidebarWidth` — each Sidebar's dragged width (clamped on read; set from the [Sidebar edge](/interface/sidebars.md)).
- `explorerOpen`, `tagsOpen`, `outlineOpen`, `backlinksOpen` — per-Section collapse.
- `propertiesShown` — the global Properties show/hide toggle.
- `editorMode` — the boolean view mode, `editing` vs `read` (the shared default for a Tile; each Tile also remembers its own mode inside `layout`).
- `layout` — the full tiling workspace ([Columns of Tiles](/editor/editor-layout.md), each with its per-Tile view mode), round-tripped as opaque JSON.
- `window` — window size/position, owned by Rust.

## How it round-trips

- **Extend-only schema.** Every field is optional and `#[serde(default)]` on the Rust side; adding a field only requires defaulting it on read, and old/new binaries tolerate each other's files. A missing or corrupt store loads as defaults — losing View state is harmless, so a parse error never propagates to the UI.
- **Defaults on read.** The session store fills absent fields: the left Sidebar and most Sections default to **open**, but **Tags**, the **right Sidebar** and **Properties** default to **collapsed/hidden**. `editorMode` defaults to `read`, and each Sidebar width defaults to `DEFAULT_SIDEBAR_WIDTH`.
- **Debounced writes.** UI changes schedule a single coalesced save (250 ms debounce) through `saveBundleState`; passing back the loaded `window` value carries the Rust-owned geometry through untouched.
- **Restore gate.** Persistence is held until the full restore (load + seed defaults + reopen the last Concept) completes, so a transient startup value can't overwrite just-loaded state.
- **Transient flags excluded.** The ephemeral reveal flags (`*Revealed`, see [Sidebars → transient reveal](/interface/sidebars.md)) are deliberately kept out of the snapshot — a keyboard visit never becomes a persisted preference.

## Relationships

- The collapse flags here back the [Sidebars and Sections](/interface/sidebars.md); `layout`/`editorMode` back the [Editor layout](/editor/editor-layout.md).
- View state is explicitly *not* part of the [Bundle](/okf/bundle.md) — the distinction the glossary flags.
- The term is resolved under **View state** in the [glossary](/GLOSSARY.md).
