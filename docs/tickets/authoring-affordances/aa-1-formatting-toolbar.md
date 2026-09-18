---
status: needs-info
priority: 3
---

# aa-1: A visible formatting bar for the editing Tile

**What to build:** someone editing a Concept can apply bold, italic, inline
code, strikethrough, headings and links by clicking a labelled control, without
knowing the markdown syntax or the hotkey. The control also reads back state:
with the caret inside a bold run, the bold control shows as active, so the bar
teaches what the document already says.

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
the bar's **placement**, which is a live design question — see below.

- [ ] An editing Tile shows controls for bold, italic, inline code,
      strikethrough, heading level and link
- [ ] Each control applies the existing command from `editor/commands.ts`; no
      formatting transform is reimplemented in a component
- [ ] Each control reflects whether the format is active at the caret, updating
      as the selection moves, via a pure query unit-tested in `src/lib`
- [ ] Each control carries its hotkey in its tooltip, so the bar teaches the
      keyboard path rather than replacing it
- [ ] Clicking a control returns focus to the editor with the selection intact
- [ ] The bar is absent or fully disabled when the Tile is in reading mode
- [ ] The bar is reachable by keyboard and announces state to a screen reader
- [ ] The bar does not steal the Region focus model's semantics — Escape and
      Tab behave as the focus model documents
- [ ] `docs/GLOSSARY.md` names the new surface and resolves the "toolbar"
      _Avoid_ entry
- [ ] Playwright covers apply, toggle-off, active-state readout and the
      reading-mode case over the fake backend
- [ ] All four gates green

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
  nav/tool bar". This ticket is in tension with that and must settle it.
- `docs/interface/focus-model.md` — six Regions in a fixed 3x2 grid, exactly
  one active. A new focusable strip has to be placed in that model, not bolted
  beside it.

## Open questions

1. **Where does the bar live?** (a) A second row inside the Concept header,
   shown only while editing, next to the undo/redo group that already appears
   conditionally. (b) A floating bar over the selection, Obsidian/Notion style,
   appearing only when text is selected. (c) A strip docked above the Editor
   pane like the Find panel.
   *Recommendation: (a).* It reuses the "controls scoped to this Concept/Tile"
   rule the glossary already states, needs no new hit-testing or positioning
   logic, and is visible before the user selects anything — which is the point
   for a non-technical author. (b) is prettier but only helps someone who
   already knows to select text first.
2. **What is the surface called?** The glossary deliberately retired "toolbar".
   *Recommendation: "Format bar"* — a second row of the Concept header, scoped
   to the Tile, which is materially not the global tool bar that was removed.
   Whatever is chosen, the glossary entries for **Concept header** and
   **Activity Rail** need editing in the same change.
3. **Is it always shown, or opt-in?** A technical author who lives on hotkeys
   loses vertical space to a row they never click.
   *Recommendation: always shown while editing for now, with the question of a
   setting deferred to a later ticket* — Sunstone has no general settings
   surface, and inventing one here widens this ticket past its purpose.
4. **Does it appear in the web shell?** Nothing here is desktop-specific.
   *Recommendation: yes, both shells* — the non-technical reader is if anything
   more likely to be on web.

## Decisions

- Controls dispatch the existing commands rather than new transforms — the
  effort README makes the pure-transform seam binding, and the toggles are
  already tested.
- Bullet/numbered lists, blockquote and horizontal rule are **not** in this
  ticket: they need new pure transforms in `textFormat.ts`, which is its own
  slice of work. This ticket ships exactly the operations the keymap already
  exposes, so the chrome and the transforms do not land in one change.
- Tables get their own affordances in `aa-2`; no table control appears in this
  bar.
