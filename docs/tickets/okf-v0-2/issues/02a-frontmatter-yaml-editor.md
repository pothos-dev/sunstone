---
status: resolved
---

# 02a: Edit Frontmatter as YAML

**What to build:** an author edits a Concept's Frontmatter as YAML text, so every OKF v0.2 family becomes writable instead of greyed out. Today the Properties panel models Frontmatter as `Property[]` and renders anything nested read-only — which is every v0.2 family (`generated` is a map, `verified` and `sources` are lists of maps, `sources[].usage_window` is a map inside a list entry). Editing the YAML directly makes all of them authorable at once, and round-trips unknown keys, comments, quoting and key order byte-for-byte, which the structured model never could. This is [ADR 0008](/adr/0008-raw-yaml-frontmatter-editing.md); it supersedes [ADR 0003](/adr/0003-structured-frontmatter-reserialization.md).

This ticket is the **editing surface only**. The linting and completion that replace the panel's autocomplete are [02b](02b-okf-language-service.md), which depends on this and on [04](04-bundle-root-okf-version-marker.md). Everything the family tickets need in order to *author* their fields lands here.

The unified undo timeline from ADR-0003 survives, but not unchanged: the YAML now has a document of its own, so the body editor's `history()` stays the single stack and the YAML editor runs with no history of its own, forwarding undo/redo to it. `frontmatterField` still holds the frontmatter with the payload changed from `Property[]` to the YAML string. Grouping becomes ours to do — CodeMirror coalesces only events that both carry document changes, so intermediate keystrokes go in with `addToHistory: false` and one history entry opens per idle pause. Because an undo step can now change a surface the user cannot see, focus follows what was undone.

- [x] The Frontmatter Region hosts a YAML editor with syntax highlighting; the `---` fences are drawn by the Region, and the editor holds the inner YAML only
- [x] A Concept with no Frontmatter shows an empty editor, and the block materialises on first save
- [x] The Region is collapsed by default in read and edit mode, and the highlighting code is lazy-loaded on expand, so nothing extra loads while it is collapsed
- [x] Read mode shows the same YAML verbatim and highlighted — never re-formatted, so what is read matches what is on disk
- [x] Opening a Concept and editing only its body leaves the Frontmatter block byte-for-byte unchanged, including comments, quoting, key order and flow style
- [x] Undo and redo cross Frontmatter and body on one timeline, and a step in the YAML editor matches what was typed rather than reverting the whole block
- [x] Undo and redo move focus to the surface they changed, expanding the Region when the step was a Frontmatter one
- [x] Clearing the Frontmatter writes a file with no `---` fences, the inverse of materialising the block on first save
- [x] The Tile header title comes from the YAML rather than from `Property[]`, and falls back to the filename stem when the block is unparseable
- [x] Escape peels exactly one layer per press: YAML editing → Region focus → body editor
- [x] An explicit format command reflows the block; nothing reformats on save
- [x] The debounced autosave writes only while the YAML parses; an explicit save writes regardless
- [x] A held write is visible on both desktop and web — an error indicator in the YAML debounced 1s so it does not flash while typing, plus a Save button to force the write — and it is clear that body edits are held too
- [x] The Region, its `data-testid`s and the docs are renamed from **Properties** to **Frontmatter**, and the Glossary's flagged-ambiguity entry for the rename is resolved
- [x] `Property[]` and everything built only on it are removed, and the Playwright specs covering the old panel are deleted or rewritten against the YAML editor
- [x] `docs/okf/concept.md`, `docs/okf/bundle.md`, `docs/editor/codemirror.md`, `docs/editor/custom-extensions.md` and the Glossary describe the YAML editor rather than the Properties panel
- [x] All four gates green
