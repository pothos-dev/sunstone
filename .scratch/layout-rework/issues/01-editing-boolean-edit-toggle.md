# 01 — Collapse editor modes to an `editing` boolean + Edit toggle in the concept header

**What to build:** On desktop, replace the three-way Source/Live/Read control with a single **Edit** toggle living in the concept header. Opening a concept lands in **read** (rendered, read-only) by default. Pressing Edit enters live editing (the old "hybrid": rendered with the cursor line shown raw). The old "Source"/raw mode is dropped entirely. Undo/redo controls appear only while editing (read-only has nothing to undo). Existing users whose persisted mode was `edit` or `hybrid` open in editing; `view` opens in read.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `EditorMode`'s three-way union is collapsed to a boolean `editing` (or equivalent) across the CodeMirror engine, session store, workspace/Tile model, and layout persistence; the `edit`/source branch and its decorations-off early return are removed.
- [ ] Default state for a freshly opened concept is **read** (non-editing).
- [ ] The segmented mode control is removed from the NavBar; a single Edit toggle button sits in the concept header (per-tile), reflecting and driving the tile's editing state.
- [ ] Undo/redo controls in the concept header are shown only while editing.
- [ ] Legacy persisted values migrate: `edit`/`hybrid` → editing, `view` → read — for both the top-level session mode and every stored per-tile mode. Round-trips through the Rust bundle-state config without data loss.
- [ ] Review buffer continues to open in read (non-editing).
- [ ] `bun test src/lib`, `bun run check`, `cargo test`, `cargo check` all green; `layoutPersist` tests updated for the new representation and migration.
- [ ] Playwright specs referencing `editor-mode-toggle` / `editor-mode-*` updated to the Edit toggle.

## Comments

- The rest of the NavBar (sidebar toggles, properties toggle) stays intact in this ticket; it is dissolved in 03.
- Decision-rich detail from investigation: the persisted representation is a string end-to-end (`EditorMode` in TS, `Option<String>` in Rust `config.rs`, per-tile `StoredTile.mode`). Migration must cover both the session-level mode and each stored tile mode.
- Unrelated `mode`/`'edit'` usages exist (Properties-nav `'nav'|'chips'|'edit'`, annotation-popup `'add'|'edit'`) — do not touch those.
