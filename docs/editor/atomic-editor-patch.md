---
type: Reference
title: The vendored atomic-editor patch
description: The local patch to @atomic-editor/editor@0.4.3 — what it changes in inline-preview and the table widget, and why each change exists.
resource: patches/@atomic-editor%2Feditor@0.4.3.patch
tags: [editor, codemirror, atomic-editor, patch, live-preview]
timestamp: 2026-07-23
---

# The vendored atomic-editor patch

Sunstone applies a single local patch to its live-preview dependency, `patches/@atomic-editor%2Feditor@0.4.3.patch`, referenced from `package.json` under the `patchedDependencies`-style `"@atomic-editor/editor@0.4.3"` key so Bun re-applies it on every install. It patches the package's built `dist/` output (the package ships compiled JS/`.d.ts`, no source). This is the "custom patches we have written" to the [atomic-editor](/editor/atomic-editor.md) dependency; Sunstone's own from-scratch extensions live in [custom CodeMirror extensions](/editor/custom-extensions.md) instead.

The patch is preferred over a fork because the changes are small and additive, and [ADR-0001](/adr/0001-codemirror-hybrid-live-preview.md) already anticipates vendoring pieces of a young, single-maintainer dependency. Where a change would be too invasive (rendering multi-line fenced bodies as widgets), Sunstone writes a sibling extension instead — see [mermaid rendering](/editor/custom-extensions.md) and [ADR-0005](/adr/0005-mermaid-block-rendering.md).

## What the patch changes

### 1. `alwaysRender` — a reading-view Facet on `inlinePreview`

Upstream `inlinePreview` hardcodes the hybrid rule "reveal raw markup on the line(s) the cursor touches". Sunstone's `view` (Reading) mode needs _every_ line rendered regardless of the cursor. The patch adds an `alwaysRenderFacet` (`Facet.define({ combine: (v) => v.some(Boolean) })`) and an `alwaysRender?: boolean` config field; when set, `buildInlineDecorations` leaves the active-line and active-link sets empty so no line reveals. The host toggles it by reconfiguring the mode [Compartment](/editor/codemirror.md). This is the change [ADR-0001](/adr/0001-codemirror-hybrid-live-preview.md)'s tri-state-mode update calls out.

### 2. URL-less `Link` nodes render as literal text (OKF citations)

The GFM parser parses a bracketed span like `[1]` (or `[note]`) with no matching reference definition as a `Link` node, even though it has no destination. Upstream would style it and hide its brackets. The patch tracks `urllessLinkStarts` — `Link` nodes with no `URL` child — and neither styles them nor hides their `[` `]`, so they render as the literal source text. This is what lets [citation markers](/editor/custom-extensions.md) like `[1]` survive as plain text for Sunstone's own citation extension to replace with a superscript. The `[n]` citation form is **deprecated** (v0.1 attribution, still read; new attribution is a `[^id]` footnote against `sources`, [ADR 0013](/adr/0013-per-claim-attribution-by-source-id.md)), but the patch stays for as long as it is read.

### 3. Bare / GFM-autolinked URLs stay visible and clickable

A bare `https://…` in running text parses as a standalone `URL` node with **no** `Link` parent. Hiding it (the default for hidden-syntax nodes) would blank the line. The patch keeps such a `URL` node visible, styles it with the link mark class, and teaches the click handler to resolve a bare `URL` node directly (walking up to `URL` as well as `Link`, and reading the node itself as the href) so bare links open too.

### 4. Whole-link click target in reading mode

In editable modes the click-to-open hit zone is the trailing external-link icon only (so a click in link text still positions the caret). In `view` mode the text isn't editable, so the patch adds a `wholeLink` parameter to `linkIconHitTarget` — driven by `alwaysRenderFacet` — that treats the entire `.cm-atomic-link` as the target. A companion CSS rule sets `cursor: pointer` on links inside `.cm-content[contenteditable="false"]`.

### 5. Inline code spans inside table cells

The table-widget cell parser (`parseCellInline` / `matchCellMarkAt`) gained a `code` token type: a `` `…` `` run is matched _first_ (a code span binds tighter than emphasis in CommonMark and its content is literal, never parsed for nested marks), rendered as a `.cm-atomic-code-wrap` with faint backtick delimiters and a `.cm-atomic-inline-code` inner span. `cm-atomic-code-wrap` is registered in `MARK_WRAP_CLASSES`, and CSS reveals its delimiters when the caret enters the wrap, matching the existing bold/italic/strike cell behaviour.

### 6. Re-export `treeGrowthEffect` / `treeProgressPlugin` from the package root

The package's budgeted-parse signals live in a `./tree-progress` module that isn't exposed via the package's export map. The patch re-exports `treeGrowthEffect` and `treeProgressPlugin` from `dist/index.js` (and `index.d.ts`) so [`mermaidBlocks`](/editor/custom-extensions.md) can subscribe to them and re-render fences that were parsed _after_ the initial 200ms parse window (relevant for long documents).

## Upgrading atomic-editor

Because the patch targets `dist/` line offsets in version `0.4.3`, any bump requires re-generating it against the new build. The six changes above are the checklist to re-verify: the two are purely additive re-exports (6), two are reading-mode affordances (1, 4), and two are parser-correctness fixes for OKF/GFM content (2, 3, 5).
