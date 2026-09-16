# Raw YAML frontmatter editing

**Supersedes:** [ADR-0003](0003-structured-frontmatter-reserialization.md)

Frontmatter is edited as **YAML text in a dedicated CodeMirror editor**, not through a
structured form. The `Property[]` model, its whole-block re-serialization, and the Properties
panel built over it are removed; what remains is the **Frontmatter Region** — a collapsible
surface hosting a small YAML editor with syntax highlighting, linting, completion and an
explicit format command ([ADR-0009](0009-marker-gated-okf-language-service.md)).

## Why drop the structured model

OKF v0.2 made every new frontmatter family nested: `generated` is a map, `verified` and
`sources` are lists of maps, and `sources[].usage_window` is a map inside a list entry. ADR-0003
classified all of those as `complex` and rendered them **read-only**, so none of the v0.2
families could be authored at all.

Growing `Property[]` to cover them meant a recursive value model, a path-based edit API to
replace positional indices, flattening nested values into the panel's 2-column spreadsheet grid,
a reorder gesture the panel has never had, and a serializer that decides block-vs-flow style for
values it did not write. Every one of those is a decision about how to **re-emit** YAML that an
agent already wrote correctly.

Editing the YAML directly removes all of them at once. It is also strictly better on the one
thing OKF actually requires ([§4.1](../okf/spec.md#41-frontmatter),
[§11](../okf/spec.md#11-conformance)): unknown keys, comments, quoting style, key order and the
spec's own `{ by, at }` flow style all round-trip **byte-for-byte**, because nothing re-emits
them. ADR-0003's `raw`/`entry` escape hatch existed to approximate this; now it is the default.

The authorship pattern argues the same way. OKF's per-claim attribution is keyed on
`sources[].id` rather than a positional index precisely because
[§5.1](../okf/spec.md#51-provenance-sources) expects *agents* to write and constantly reorder
these lists. The human's job is mostly reading, and occasionally correcting one field — which a
good text editor serves better than a form.

## What is kept from ADR-0003

**Unified undo.** ADR-0003's real win was that frontmatter edits ride CodeMirror's
transaction/history machinery, so undo crosses frontmatter and body on one timeline. That
survives — but it cannot survive *unchanged*, because the YAML now has a document of its own.
The body editor's `history()` stays the **single** undo stack; the YAML editor runs with **no
history of its own** and forwards its undo/redo bindings to that stack. `frontmatterField` keeps
holding the frontmatter (payload changed from `Property[]` to the YAML `string`), the YAML
editor's document mirrors that field, and every edit is dispatched back into the body editor as a
`setFrontmatter` effect whose inverse `frontmatterUndo` records.

Two things follow from putting a second document on one stack.

**Grouping is ours to do.** CodeMirror's history only coalesces two events when *both* carry
document changes, so effect-only frontmatter transactions would each become their own undo step —
one per keystroke. Intermediate keystrokes are therefore dispatched with `addToHistory: false`,
and a single history entry is opened per **idle pause**, carrying the value the group started
from. The group also closes on blur, on an explicit save, before an undo or redo, and on a
Concept switch, so a frontmatter step can never land in the timeline after a body edit that
followed it.

**Undo moves the cursor to what it undid.** With two surfaces on one stack an undo step can
change content the user cannot see — the Region is collapsed by default. So after an undo or
redo, focus follows the change: into the YAML editor, expanding the Region if it is collapsed,
when the step carried a `setFrontmatter`; into the body otherwise.

## Shape

- The YAML lives in a **separate CodeMirror** in the Frontmatter Region, not in the main
  document. The body editor stays body-only and the `frontmatterLineCount` offsetting is
  unaffected.
- The editor holds the **inner YAML only**. The `---` fences are structure, not content
  ([§2](../okf/spec.md#2-terminology)); the Region draws them, using the existing
  `open` / `yaml` / `close` split from `sunstone-shared`. A Concept with no frontmatter shows an
  empty editor that materialises the block on first save.
- The Region is **collapsed by default** in both read and edit mode (`propertiesShown` already
  defaults to `false`), and the highlighting code is **lazy-loaded on expand**, following the
  `hydrateMermaid` precedent. Read mode shows the same YAML **verbatim**, highlighted — never
  re-formatted, so what is read matches what is on disk.
- **Escape peels two layers**: YAML editing → Region focus → body editor, keeping the
  one-layer-per-press contract uniform across Regions.
- **Clearing the YAML removes the block.** Frontmatter that is empty or whitespace-only writes a
  file with no `---` fences at all — the inverse of the materialise-on-first-save rule, so the two
  directions agree and no Concept is left carrying an empty pair of fences.
- **Whatever needs one field parses the YAML for it.** With `Property[]` gone there is no
  structured mirror to read `title` off, so the Tile header (`tileTitle`) parses the frontmatter
  it is handed. Parsing is cheap, failure is tolerated (an unparseable block falls back to the
  filename stem), and it keeps the YAML text the single source of truth.
- **Formatting is an explicit command, never on save.** The `yaml` library preserves comments and
  quoting across a parse/stringify round-trip but normalises whitespace, so formatting on save
  would reflow every file merely on being edited.

## The save gate

A text editor produces unparseable YAML constantly — mid-keystroke is the normal case — and the
write path is a debounced autosave that the web deployment **commits**
([ADR-0007](0007-server-owns-the-git-sync-loop.md)). So:

- The debounced autosave writes **only when the YAML parses**. While it does not, the write is
  held and the Concept stays dirty.
- An **explicit save writes regardless**, because losing the author's text is worse than a
  momentarily broken file. On the web path that still commits invalid YAML, by design.
- A held write must be **visible**: an error indicator in the YAML, debounced 1s so it does not
  flash while typing, plus a Save button — which today exists only on the web, since the desktop
  autosaves and never needed one.

Because the write is whole-file, a held frontmatter write holds **body edits too**. There is no
way to persist half a Concept.

## Consequences

- Removed: `Properties.svelte`, `PropertyRow.svelte`, `PropertiesAddRow.svelte`,
  `propertiesEdits.ts`, `propertiesGrid.ts`, `chipStrip.ts`, `propertiesNav.svelte.ts`, most of
  `frontmatter.ts`, and roughly thirty Playwright specs.
- **Capabilities lost:** tag chips and tag autocomplete, `type` value suggestions, the
  spreadsheet grid navigation over properties, and duplicate-key *rejection* — the panel refused
  them outright. The `yaml` parser does report a duplicate, but the save gate asks with
  `uniqueKeys: false` on purpose: a duplicate still yields a document (last wins), so it is a
  lint finding, not a reason to refuse a write. Completion restores the suggestions, but only in
  a bundle that declares `okf_version` ([ADR-0009](0009-marker-gated-okf-language-service.md)).
- Authors now need to know YAML. That is the trade: a form that cannot express the format, versus
  a text editor that can express all of it and lints what it cannot prevent.
- The Region is renamed from **Properties** to **Frontmatter**, matching the Glossary term and
  the spec's own word, now that the `Property[]` type it was named after is gone.
