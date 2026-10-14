---
status: done
priority: 3
---

# wr-1: The web reader uses the desktop Tile header

**What to build:** the anonymous web reader shows the same Concept header as
the desktop and the signed-in web App — `TileHeader` — instead of its own
"concept strip". Same title with folder crumbs, same lifecycle chips, same
look; only the controls that make sense read-only are shown.

- [x] `WebReader` renders `TileHeader` in place of the `.concept-strip` markup; the strip's own title/lifecycle markup and its CSS are deleted
- [x] Folder crumbs show and work: a crumb with an `index.md` opens it, any other reveals the folder in the reader's Explorer
- [x] Read-only controls only: no undo/redo, Edit, Save, Review, split or close; Properties toggle and Export PDF keep working (as `TileHeader` controls, adding props/slots to `TileHeader` where needed, without changing the desktop's behaviour)
- [x] Back/Forward are not shown on web (the browser drives history, as in the signed-in App)
- [x] Narrow screens: the drawer toggles, quick nav and overflow menu still appear at ≤ 768px
- [x] The header renders in the SSR HTML (first paint)
- [x] Web e2e specs updated for the new header (`concept-strip` test ids replaced or kept as aliases), desktop suite unaffected; all four gates green

## Grounding

- `src/lib/PageShell.svelte` forks: signed in → full `App.svelte` via
  `WebAppShellIsland` (already has `TileHeader`); anonymous → `WebReader`.
- `WebReader.svelte:389` builds the "concept strip": a title span with the
  `tile-title` test id, `LifecycleBadge`, a Properties toggle, Export PDF, and
  narrow-only drawer / quick-nav / overflow buttons.
- `src/lib/components/TileHeader.svelte` imports only `LifecycleBadge` and
  types; everything else is props, so it can render in the SSR reader.
  Crumbs come from `src/lib/tileTitle.ts`.
- The strip predates the reader split (`3e4ac7f`, `35c08a9`); it was never a
  deliberate divergence.

## Decisions

- Why the reader had its own header → historical: the anonymous surface was
  built separately to keep CodeMirror out of SSR, and the header came along.
  `TileHeader` needs neither, so it is reused (Daniel, 2026-10-14).
- Controls TileHeader lacks (Properties toggle, narrow-only buttons) → add
  optional props or snippet slots to `TileHeader`; the desktop passes none.
- The reader's Properties toggle → the header's existing Frontmatter toggle
  (the glossary avoids "Properties"); the overflow-menu item reads
  "Show/Hide Frontmatter". `concept-strip` / `properties-panel-toggle` test ids
  are replaced, not aliased.
- A folder `index.md`'s own folder is not a crumb in the reader: its label
  (`conceptTitle`) always names it after the folder.

## Comments

- 2026-10-14 (agent): Done. `TileHeader` grew `readOnly` plus `leading` /
  `trailing` snippets; its editing props became optional (the desktop still
  passes them all). Crumbs come from `web/readerHeader.ts`; a crumb without an
  index opens the Explorer drawer on a narrow screen. New spec
  `tests/web-reader-header.spec.ts` (SSR HTML, read-only controls, both crumb
  kinds). Web suite 61/61, desktop suite 234 + 1 flaky
  (`focus-grid-navigation`, passed on retry, unrelated).
