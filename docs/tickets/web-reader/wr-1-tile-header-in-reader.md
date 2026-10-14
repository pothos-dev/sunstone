---
status: ready
priority: 3
---

# wr-1: The web reader uses the desktop Tile header

**What to build:** the anonymous web reader shows the same Concept header as
the desktop and the signed-in web App — `TileHeader` — instead of its own
"concept strip". Same title with folder crumbs, same lifecycle chips, same
look; only the controls that make sense read-only are shown.

- [ ] `WebReader` renders `TileHeader` in place of the `.concept-strip` markup; the strip's own title/lifecycle markup and its CSS are deleted
- [ ] Folder crumbs show and work: a crumb with an `index.md` opens it, any other reveals the folder in the reader's Explorer
- [ ] Read-only controls only: no undo/redo, Edit, Save, Review, split or close; Properties toggle and Export PDF keep working (as `TileHeader` controls, adding props/slots to `TileHeader` where needed, without changing the desktop's behaviour)
- [ ] Back/Forward are not shown on web (the browser drives history, as in the signed-in App)
- [ ] Narrow screens: the drawer toggles, quick nav and overflow menu still appear at ≤ 768px
- [ ] The header renders in the SSR HTML (first paint)
- [ ] Web e2e specs updated for the new header (`concept-strip` test ids replaced or kept as aliases), desktop suite unaffected; all four gates green

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
