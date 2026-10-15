---
status: review
priority: 3
---

# aa-1: A formatting toolbar for the editing Tile

**What to build:** someone editing a Concept can apply bold, italic, inline
code, strikethrough, headings and links by clicking a labelled control, without
knowing the markdown syntax or the hotkey. The control also reads back state:
with the caret inside a bold run, the bold control shows as active, so the
toolbar teaches what the document already says.

Every transform this needs already exists. `editor/textFormat.ts` holds the
pure toggles — `toggleInlineWrap`, `headingFormatEdit`, `insertLink`, `linkAt` —
and `editor/commands.ts` wraps them as CodeMirror commands that no-op in
read-only mode. `editor/extensions.ts` binds them to `Mod-B`, `Mod-I`, `Mod-E`,
`Mod-Shift-M` and `Mod-0`…`Mod-6`. The header comment in `textFormat.ts` already
says the transforms are "for the editor toolbar / keymap". What is missing is
the chrome and the active-state query; nothing in the markdown layer changes.

Two things are genuinely new. First, **active-state readout**: no code today
asks "is the caret inside a `**` run" or "what heading level is this line".
That is a new pure query over doc + selection, unit-tested alongside the
toggles, driven off CodeMirror's selection updates rather than polled. Second,
the toolbar's **placement**: a second row inside the per-Tile Concept header,
under the existing title/controls row and above the editor text, shown only
while the Tile is editing.

- [x] An editing Tile shows a toolbar as a second row of its Concept header,
      carrying controls for bold, italic, inline code, strikethrough, heading
      level and link
- [x] Each control applies the existing command from `editor/commands.ts`; no
      formatting transform is reimplemented in a component
- [x] Each control reflects whether the format is active at the caret, updating
      as the selection moves, via a pure query unit-tested in `src/lib`
- [x] Each control carries its hotkey in its tooltip, so the toolbar teaches
      the keyboard path rather than replacing it
- [x] Clicking a control returns focus to the editor with the selection intact
- [x] The toolbar is absent when the Tile is in reading mode, and present in
      both the desktop and the web shell
- [x] The toolbar is reachable by keyboard and announces state to a screen
      reader
- [x] The toolbar does not steal the Region focus model's semantics — Escape
      and Tab behave as the focus model documents
- [x] The toolbar does not break the Concept header's existing layout at narrow
      Tile widths (a Column can be a third of the Editor pane)
- [x] `docs/GLOSSARY.md` carries a **Toolbar** entry and the _Avoid_ lines
      under **Concept header** and **Activity Rail** no longer claim the term
      is removed
- [x] Playwright covers apply, toggle-off, active-state readout and the
      reading-mode case over the fake backend
- [x] All four gates green

## Grounding

- `src/lib/editor/textFormat.ts` — pure transforms, already unit-tested in
  `textFormat.test.ts`. Toggling semantics (re-apply removes) are settled.
- `src/lib/editor/commands.ts` — `inlineWrapCommand`, `headingCommand`,
  `annotateCommand`; each returns `false` when `view.state.readOnly`.
- `src/lib/editor/extensions.ts:257-269` — the existing keymap. Adding chrome
  must not change these bindings.
- `src/lib/components/TileHeader.svelte` — the per-Tile Concept header, the
  existing home for Tile-scoped controls (back/forward, Edit, Frontmatter,
  undo/redo shown only while editing, review, export, split, close). It is
  already dense.
- `docs/GLOSSARY.md`, "UI chrome" — **Concept header** lists "toolbar
  (removed)" under _Avoid_, and **Activity Rail** states "there is no global
  nav/tool bar". Both are now stale; see the naming decision below for exactly
  what to change.
- `docs/interface/focus-model.md` — six Regions in a fixed 3x2 grid, exactly
  one active. A new focusable strip has to be placed in that model, not bolted
  beside it.

## Decisions

- **Placement → a second row of the Concept header, shown only while editing.**
  It reuses the "controls scoped to this Concept/Tile" rule the glossary already
  states, needs no hit-testing or positioning logic, and is visible before the
  user selects anything — which is the point for a non-technical author. A
  floating selection bar only helps someone who already knows to select first.
- **Name → "Toolbar".** The decision to retire the term is reversed: it is the
  word a non-technical user already knows, and this effort exists for them.
  `docs/GLOSSARY.md` gains a **Toolbar** entry (per-Tile, editing-only,
  formatting controls) and the _Avoid_ lines under **Concept header** and
  **Activity Rail** are corrected in the same change — the Rail is still not a
  toolbar, and there is still no *global* tool bar, so those entries narrow
  rather than disappear.
- **Always shown while editing**, absent in reading mode. No toggle and no
  setting: Sunstone has no general settings surface, and inventing one here
  widens the ticket past its purpose. Revisit only if the row proves to cost
  too much vertical space in practice.
- **Both shells.** Nothing here is desktop-specific, and the non-technical
  reader this effort targets is if anything more likely to be on web.
- Controls dispatch the existing commands rather than new transforms — the
  effort README makes the pure-transform seam binding, and the toggles are
  already tested.
- Bullet/numbered lists, blockquote and horizontal rule are **not** in this
  ticket: they need new pure transforms in `textFormat.ts`, which is its own
  slice of work. This ticket ships exactly the operations the keymap already
  exposes, so the chrome and the transforms do not land in one change.
- Tables get their own affordances in `aa-2`; no table control appears in this
  toolbar.

## Comments

**2026-10-15 (nightly agent):** Built; every box above is met and the four gates,
the desktop Playwright suite and a web e2e spec are green. Set to `review`, not
`done`, because these need a person's judgement:

1. **Caret inside a run.** With the caret inside `**bold**` (nothing selected),
   Bold shows as pressed, but clicking it does what `Mod-B` already does there:
   it inserts an empty `****` pair at the caret instead of unbolding the word.
   Only a selection over the run (or the whole marked run) toggles it off. That
   is the settled `toggleInlineWrap` semantics, so I left it alone. A
   non-technical author may expect the click to unbold the word. Changing that
   means a new pure transform (expand to the enclosing run), so it would be a
   follow-up ticket.
2. **Link has no hotkey.** The keymap binds none, so the link control's tooltip
   names no shortcut. I did not add `Mod-K`, because the app already uses
   `Ctrl/Cmd+K` for Quick nav.
3. **Vertical space at narrow widths.** In a third-width Column the header now
   takes four short rows while editing (title, wrapped controls, the second
   control row, Toolbar). It stays inside the Tile (Playwright checks this),
   but whether that costs too much height is a call to make by eye.
4. **Screen reader.** State is exposed as `role="toolbar"` + `aria-pressed` +
   labelled controls + a labelled `<select>`. Playwright checks the attributes.
   Nobody has listened to it with a real screen reader.

Keyboard path: `Alt+F10` from the Tile moves focus into the Toolbar (Tab
indents in the text, so it cannot be the way in), arrows/Home/End move between
controls, and Escape returns to the text. The formatting keymap moved,
unchanged, into `editor/formattingKeymap.ts`, so a unit test can check the
Toolbar's tooltips against it.
