---
status: done
---

# ov-15: Fold blocks in the Frontmatter YAML editor

**What to build:** an author can fold any nested block in the Frontmatter YAML editor, and the bulky v0.2 lists start folded, so an expanded Frontmatter Region shows the short keys at a glance instead of a screen of `sources`. Folding is display only: the file stays byte-for-byte what it was (ADR 0008).

- [x] A fold gutter in the YAML editor folds any line whose following lines are indented deeper (a nested map, a list, a list entry, a block scalar), plus a key followed by a same-indent `- ` list
- [x] A folded block shows a placeholder that says what is inside: `N entries` for a list, `N keys` for a map, `N lines` otherwise
- [x] Top-level `sources` and `verified` start folded each time a Concept opens in the Region; nothing else does
- [x] Clicking the placeholder unfolds it; folding works in read mode as well as edit mode
- [x] Folding never changes the YAML text or the undo history
- [x] The fold-range logic is pure TS with unit tests; a desktop Playwright spec covers the default fold and unfolding
- [x] Docs describe the folding
- [x] All four gates green

## Grounding

The Region is `src/lib/components/Frontmatter.svelte` over `buildFrontmatterEditor` (`src/lib/editor/frontmatterEditor.ts`), a second CodeMirror with no history of its own. `@codemirror/lang-yaml` only folds flow collections (`{…}` / `[…]`), and the grammar is lazy-loaded, so folding is an indentation `foldService` of ours, loaded with the editor rather than the grammar. A Concept switch reaches the editor as `syncFromHost`, the same path as undo and external reloads, so re-applying the default folds needs to know the Concept changed: the Tile bumps a `concept` counter each time it loads one.

## Decisions

- Default-folded keys → `sources` and `verified`, the two v0.2 lists that grow without bound. Not a size threshold, which would fold different keys from one Concept to the next.
- Folds are re-applied when the Concept changes, not on undo/redo or reload, so a block the author unfolded stays open while they work.
- Indentation folding rather than the YAML syntax tree: it works before the lazy grammar arrives and has no failure mode on half-typed YAML.
