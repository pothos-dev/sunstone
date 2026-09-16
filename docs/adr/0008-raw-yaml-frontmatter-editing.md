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
mechanism survives unchanged in shape: `frontmatterField` + `setFrontmatter` + `frontmatterUndo`
(`invertedEffects`) stay, with the effect payload changed from `Property[]` to the YAML `string`.

What changes is granularity. `dispatchFrontmatter` currently fires `isolateHistory.of('full')`
because a panel edit is one discrete act; a text editor is not. Keystrokes are **grouped into one
effect per idle pause**, on the same boundary as the lint debounce, so undo steps match what was
typed rather than reverting the whole block at a time.

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
  them outright, and `yaml` does not even warn by default, so it returns as a lint rule.
  Completion restores the suggestions, but only in a bundle that declares `okf_version`
  ([ADR-0009](0009-marker-gated-okf-language-service.md)).
- Authors now need to know YAML. That is the trade: a form that cannot express the format, versus
  a text editor that can express all of it and lints what it cannot prevent.
- The Region is renamed from **Properties** to **Frontmatter**, matching the Glossary term and
  the spec's own word, now that the `Property[]` type it was named after is gone.
