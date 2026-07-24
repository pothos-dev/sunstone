# Mermaid diagram rendering as a parallel block-replace extension

We render ` ```mermaid ` fenced blocks as diagrams via our **own CodeMirror `StateField`
extension** (`mermaidBlocks()`, in `src/lib/editor/`), built alongside — not on top of —
atomic-editor's `imageBlocks`/`tables`, because atomic-editor exposes **no generic
block-renderer seam**: each block type is a dedicated, purpose-built field. The field walks
the syntax tree for `FencedCode` nodes whose info string is `mermaid`, lazy-loads
`mermaid` on first use, and renders the diagram with `securityLevel: 'strict'`. Scope is
**rendering only** — editing a diagram is editing its raw fence text, exactly as for any
other code block.

## Considered Options

- **Block-replace reveal (chosen)** — a `Decoration.replace({ block: true })` spans the whole
  fence; the diagram shows when the cursor is outside, and the raw source is revealed when the
  cursor enters it while `editing`, and is always rendered in `read`. We must own
  this because mermaid fences are **multi-line** and atomic-editor's `inlinePreview` only hides
  fence *markers* (`CodeMark`/`CodeInfo`), not the fence *body* — so the image trick ("widget
  below + let `inlinePreview` hide the one-line source") would leave the raw body visible under
  the diagram.
- **Widget-below, source always visible** — what `imageBlocks` effectively does for one-line
  images. Rejected: clutters both view modes with raw mermaid text under every diagram, defeating
  the hybrid-preview premise (see [ADR-0001](0001-codemirror-hybrid-live-preview.md)).
- **Patching `inlinePreview` to render fenced bodies as widgets** — invasive change to the
  vendored dependency for a single block type; a sibling field keeps the surface small and
  replaceable.

## Consequences

- **Lazy-loaded** via dynamic `import('mermaid')`, gated on the document actually containing a
  mermaid block, so documents with no diagrams never pay mermaid's (large) bundle cost — matching
  the per-language lazy-load already used for code grammars.
- **`securityLevel: 'strict'`** (no click callbacks, no raw HTML labels). OKF bundles are
  shareable, so a diagram's source may originate from an untrusted author; strict sanitisation is
  the safe default. Interactivity can be revisited later.
- **Theme sync isn't free.** A rendered diagram is a baked SVG inside a `StateField` that lives
  outside Svelte reactivity, so CSS-variable inheritance can't recolour it. An `$effect` in
  `App.svelte` dispatches a theme-changed `StateEffect` into the editor; the field rebuilds on it,
  just as it already rebuilds on atomic-editor's `treeGrowthEffect` (needed so blocks parsed after
  the initial budgeted parse still render).
- **Editing affordance.** Because a `block: true` replace has no clickable source, the widget
  carries a hover hint and a double-click handler that dispatch a selection into the fence to lift
  the replacement; entering `editing` via the Edit toggle is the always-available fallback.
- **Correctness/cost.** `WidgetType.eq()` keyed on `(source + resolvedTheme)` lets CodeMirror
  reuse DOM so unrelated edits don't re-render diagrams; a module-level `source→SVG` cache and a
  per-render generation token (discarding stale async results) keep rendering cheap and race-free.
- Pure logic (block detection, ranges, cursor-overlap, theme mapping) lives in a unit-tested
  plain `.ts` module per the repo convention; the async/DOM rendering shell is covered by
  Playwright where the sandbox allows.
