# 03 — Edge-toggle + resizable sidebars, Properties toggle to header, delete NavBar (desktop)

**What to build:** Make both sidebars controllable from their own borders: clicking a sidebar's edge collapses/expands it; dragging the edge resizes it, with the width remembered across sessions. Move the Properties toggle out of the NavBar into the concept header (Properties shows the open concept's frontmatter, so it is concept-scoped). With the editor-mode control (01), the sidebar toggles (now edges), and the Properties toggle all relocated, the NavBar has nothing left — delete it. This removes the double-header: a single open concept now shows only its concept header, no global bar above it.

**Blocked by:** 01 (the concept header must already exist as Properties' new home and the mode control must be gone), 02 (both restructure the App shell grid).

**Status:** done

- [ ] Each sidebar's border is a click target that collapses/expands that sidebar.
- [ ] Each sidebar's border is draggable to resize; widths persist across sessions (new width state added to the session store + bundle-state config, mirroring the existing `*Open` pattern).
- [ ] Collapse/expand and resize work independently for left and right sidebars.
- [ ] The Properties toggle lives in the concept header and drives the existing properties-shown state.
- [ ] The NavBar component is deleted and removed from the App shell; no global top bar remains.
- [ ] Existing sidebar open/close state and section reveal behaviour still work (Explorer/Tags, Outline/Backlinks).
- [ ] `bun test src/lib`, `bun run check`, `cargo test`, `cargo check` all green; Playwright specs referencing `sidebar-toggle`, `right-sidebar-toggle`, `properties-panel-toggle` updated to the new edge/header affordances.

## Comments

- No sidebar width state exists today — sizing is hard-coded CSS and collapse is width→0. This ticket introduces the persisted width state.
- Tiling-workspace dividers already exist but are weight-based for tiles, not pixel widths for sidebars — not directly reusable.
