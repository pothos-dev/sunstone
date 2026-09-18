# Authoring affordances

Make Sunstone usable by someone who does not write markdown by hand. Every
formatting operation the editor supports today is reachable only by typing the
syntax or by knowing a hotkey, and every table operation is reachable only by
right-clicking a cell. For a technical author that is fine; for the
non-technical colleague who has to keep a Bundle up to date it is a wall.

Decisions that bind the tickets here:

- **The pure-transform seam is the contract.** Formatting logic lives in plain
  `.ts` (`editor/textFormat.ts` already holds the toggles) and the chrome only
  dispatches commands from `editor/commands.ts`. A new affordance never
  reimplements a transform, and a new transform lands as a pure function with
  unit tests before any chrome is drawn.
- **Discoverability, not a new editing model.** These tickets add visible entry
  points and state readout for behaviour the editor already has. They do not
  turn Sunstone into a WYSIWYG word processor and they do not change the file
  on disk in any way a hand-written markdown author would not recognise.
- **Reading mode stays inert.** Every affordance is absent or disabled when the
  Tile is not editing, matching the read-only gating that
  `editor/tableReadOnly.ts` already enforces for table widgets.
- **"Toolbar" is back, scoped to the Tile.** `docs/GLOSSARY.md` retired the
  term when a global tool bar was removed in favour of the Activity Rail and
  the per-Tile Concept header. `aa-1` reverses that for a per-Tile,
  editing-only formatting row, because it is the word a non-technical user
  already knows. There is still no *global* tool bar and the Rail is still not
  one — the _Avoid_ entries narrow rather than vanish.

Out of scope: visual redesign and theming, a block-insert / slash-command menu,
image or diagram authoring (see the `embedded-images` effort), and anything
that changes the Bundle's contents beyond the open Concept's body.
