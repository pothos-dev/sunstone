---
status: ready-for-agent
priority: 3
blocked-by: [aa-1]
---

# aa-2: Create and restructure tables without writing pipes

**What to build:** someone editing a Concept can insert a table, move between
its cells with the keyboard, add and remove rows and columns from a visible
control, and set a column's alignment — none of which requires seeing or typing
a `|`. The document on disk stays ordinary GFM markdown that a hand-writing
author would recognise.

Part of this already works. `@atomic-editor/editor`'s `tables()` extension,
wired in `editor/extensions.ts:217`, renders a table as a widget whose cells are
inner `contenteditable` divs, and ships a right-click cell menu with exactly six
items: insert row above/below, insert column left/right, delete row, delete
column. `editor/tableReadOnly.ts` locks the cells and swallows that menu in
reading mode. So in-place cell editing and basic restructuring exist — behind a
right-click, which a non-technical user will never find.

The real gaps are three. There is **no way to create a table at all** except by
typing the header and separator rows by hand. There is **no alignment control**,
so the `:---:` separator syntax is unreachable from the UI. And the existing
operations are **undiscoverable**: no hover control, no visible handle, nothing
in any bar.

- [ ] An editing Tile offers "Insert table", which asks for (or defaults to) a
      size and inserts a valid GFM table with the caret in the first cell
- [ ] Row and column insert/delete are reachable without a right-click, from a
      table group that appears in the `aa-1` toolbar while the caret is inside
      a table
- [ ] The existing right-click cell menu keeps working and drives the same
      transforms as the toolbar group
- [ ] Per-column alignment (left / center / right / none) can be set from the
      UI and round-trips through the `---` / `:---` / `:---:` / `---:`
      separator row
- [ ] Tab and Shift+Tab move between cells; Tab in the last cell adds a row,
      and Escape leaves the table
- [ ] Every operation produces markdown that reparses to the same table, with
      the separator row kept valid, and leaves a single undo step
- [ ] Nothing new is editable in reading mode — the `readOnlyTables` lock still
      holds, including for any new affordance
- [ ] Insert-table, alignment and row/column change land as pure functions in
      `src/lib` with unit tests; the vendored patch grows only for
      Tab-between-cells, if at all
- [ ] Playwright covers insert, cell navigation, row/column change, alignment
      and the reading-mode lock over the fake backend
- [ ] All four gates green

## Grounding

- `src/lib/editor/extensions.ts:217` — `tables({ onLinkClick })` from
  `@atomic-editor/editor` 0.4.3 (a patched dependency; see
  `patches/@atomic-editor%2Feditor@0.4.3.patch`, which already extends the
  cell-inline parser with inline code).
- `node_modules/@atomic-editor/editor/dist/table-widget.js` — the cell menu's
  full vocabulary is *Insert row above/below*, *Insert column left/right*,
  *Delete row*, *Delete column*. No insert-table, no alignment, no row/column
  move.
- `src/lib/editor/tableReadOnly.ts` — reading-mode lock. It works by clearing
  `contenteditable` after every DOM write and swallowing the cell `contextmenu`
  in the capture phase, because `EditorState.readOnly` does not reach a
  widget's raw DOM. Any new affordance must be locked the same way, and the
  ticket should extend `setTableCellsEditable` rather than add a parallel
  mechanism.
- Cells commit edits with `view.dispatch` from inside the widget, so undo
  granularity is the widget's, not ours — worth checking before promising "a
  single undo step".
- `docs/adr/0005-mermaid-block-rendering.md` — the precedent for widget
  behaviour across modes (widget in reading/hybrid, raw source under the cursor,
  plain text in source mode, stable decoration identity).

## Decisions

- **Wrap the widget, do not grow the patch.** The missing operations —
  insert-table, alignment, row/column change — land as pure transforms over the
  document text in `src/lib`, driven from Sunstone's own chrome.
  `patches/@atomic-editor%2Feditor@0.4.3.patch` is already load-bearing and gets
  harder to rebase with every upstream release, and a pure transform is testable
  under `bun test src/lib`, which is the seam the effort README makes binding.
  The patch is reserved for the one thing only the widget's internals can do:
  Tab/Shift+Tab between cells, which lives in the widget's own DOM.
- **Controls live in the `aa-1` toolbar**, as a table group that appears when
  the caret is inside a table. This is why `aa-2` is blocked by `aa-1`. It needs
  no hit-testing against widget geometry and is keyboard-reachable for free.
  Notion-style hover handles on the table edges are a later ticket, not this
  one. Advertising the existing right-click menu is not an answer —
  undiscoverability is the whole ticket.
- **The existing cell context menu stays.** It already works and someone has
  learned it; the toolbar group is an additional entry point to the same
  operations, not a replacement. Both drive the same transforms.
- **"Insert table" inserts a fixed 3x3 with a header row**, caret in the first
  cell. Row and column insert ship in this same ticket, so growing it is one
  click away. A size-picker grid is polish that can follow.
- **Tab in the last cell adds a row**, matching Word and Notion — it is what
  someone who does not write markdown expects. Escape is the documented way out
  of the table, and this belongs in whatever user-facing keyboard reference the
  repo carries.
- The on-disk format stays plain GFM — pipes and a separator row. No HTML
  tables, no bespoke fence. The whole effort's premise is that the file is still
  ordinary markdown.
- Column alignment is expressed only through the separator row, since that is
  the only alignment GFM has.
- Cell *content* formatting (bold, links, inline code inside a cell) is out of
  scope: the patched widget already parses those tokens, and the `aa-1` bar
  acting on cell content is a follow-up, not part of this ticket.
- Merged cells, nested tables and CSV import are out of scope — none are
  expressible in GFM.
