---
status: ready-for-agent
---

# 02a: Edit Frontmatter as YAML

**What to build:** an author edits a Concept's Frontmatter as YAML text, so every OKF v0.2 family becomes writable instead of greyed out. Today the Properties panel models Frontmatter as `Property[]` and renders anything nested read-only — which is every v0.2 family (`generated` is a map, `verified` and `sources` are lists of maps, `sources[].usage_window` is a map inside a list entry). Editing the YAML directly makes all of them authorable at once, and round-trips unknown keys, comments, quoting and key order byte-for-byte, which the structured model never could. This is [ADR 0008](/adr/0008-raw-yaml-frontmatter-editing.md); it supersedes [ADR 0003](/adr/0003-structured-frontmatter-reserialization.md).

This ticket is the **editing surface only**. The linting and completion that replace the panel's autocomplete are [02b](02b-okf-language-service.md), which depends on this and on [04](04-bundle-root-okf-version-marker.md). Everything the family tickets need in order to *author* their fields lands here.

The unified undo timeline from ADR-0003 survives — `frontmatterField` / `setFrontmatter` / `frontmatterUndo` keep their shape, with the effect payload changed from `Property[]` to the YAML string. What changes is granularity: `isolateHistory.of('full')` made sense for a discrete form edit and does not for typing, so keystrokes group into one effect per idle pause.

- [ ] The Frontmatter Region hosts a YAML editor with syntax highlighting; the `---` fences are drawn by the Region, and the editor holds the inner YAML only
- [ ] A Concept with no Frontmatter shows an empty editor, and the block materialises on first save
- [ ] The Region is collapsed by default in read and edit mode, and the highlighting code is lazy-loaded on expand, so nothing extra loads while it is collapsed
- [ ] Read mode shows the same YAML verbatim and highlighted — never re-formatted, so what is read matches what is on disk
- [ ] Opening a Concept and editing only its body leaves the Frontmatter block byte-for-byte unchanged, including comments, quoting, key order and flow style
- [ ] Undo and redo cross Frontmatter and body on one timeline, and a step in the YAML editor matches what was typed rather than reverting the whole block
- [ ] Escape peels exactly one layer per press: YAML editing → Region focus → body editor
- [ ] An explicit format command reflows the block; nothing reformats on save
- [ ] The debounced autosave writes only while the YAML parses; an explicit save writes regardless
- [ ] A held write is visible on both desktop and web — an error indicator in the YAML debounced 1s so it does not flash while typing, plus a Save button to force the write — and it is clear that body edits are held too
- [ ] The Region, its `data-testid`s and the docs are renamed from **Properties** to **Frontmatter**, and the Glossary's flagged-ambiguity entry for the rename is resolved
- [ ] `Property[]` and everything built only on it are removed, and the Playwright specs covering the old panel are deleted or rewritten against the YAML editor
- [ ] `docs/okf/concept.md`, `docs/okf/bundle.md`, `docs/editor/codemirror.md`, `docs/editor/custom-extensions.md` and the Glossary describe the YAML editor rather than the Properties panel
- [ ] All four gates green
