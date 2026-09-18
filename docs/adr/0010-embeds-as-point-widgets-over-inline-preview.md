# Embeds render as point widgets layered over `inlinePreview`

An **[Embed](/GLOSSARY.md)** renders through our own CodeMirror `StateField`
(`embedBlocks()`, in `src/lib/editor/`) that emits exactly one **point**
`Decoration.widget` per Embed and **never a replace**. Hiding the raw
`![alt](x.png)` source, and revealing it again under the cursor, is left entirely to
atomic-editor's `inlinePreview`, which already `Decoration.replace`s the whole `Image`
node on every inactive line (`inline-preview.js:553-572`) and treats no line as active
when Sunstone's patched `alwaysRender` flag is set in `read` mode.

The widget's placement branches on one predicate — is the Embed the only content on its
line?

- **Alone on its line** → `Decoration.widget({ block: true, side: 1 })` at `line.to`, so
  the image sits below its source line. This is exactly the shape of upstream's
  `imageBlocks`, which this field replaces and which is dropped from the extension list
  so nothing double-renders.
- **Among text** → an inline `Decoration.widget({ side: 1 })` at the node's end, so the
  image stays in the paragraph flow where its author put it. The inline widget is
  suppressed while its own line is active, following the cursor-overlap skip already used
  by `citations.ts` and `smartDashesView.ts`, so the line you are editing shows source
  only.

This is a deliberate divergence from [ADR-0005](0005-mermaid-block-rendering.md), which
chose a block-replace for Diagrams and explicitly rejected the widget-below model. That
rejection was reasoned entirely from mermaid fences being **multi-line**: `inlinePreview`
hides fence *markers* but not a fence *body*, so a widget-below would have left raw
mermaid under every Diagram. An Embed is a **single-line** construct with a dedicated
`Image` branch in `inlinePreview` that hides it whole, so ADR-0005's reason does not
transfer and its conclusion should not either.

## Considered Options

- **Point widget over `inlinePreview` (chosen)** — the only option that needs no patch to
  the vendored dependency and no decoration of ours overlapping one of upstream's. It also
  inherits `alwaysRender` for free, so `read` mode is correct without a second code path.
- **Block-replace over the Embed range, like a Diagram** — uniform with ADR-0005, but our
  replace would cover the same range `inlinePreview` already replaces, and a replace
  cannot render the inline case at all. Consistency with Diagrams would have been the
  entire argument for it.
- **Patch `inlinePreview` to drop its `Image` branch, then replace the range ourselves** —
  there is precedent (`patches/@atomic-editor%2Feditor@0.4.3.patch`), but it buys nothing
  a point widget does not already give, and every patched hunk is a rebase cost on the next
  upstream bump.
- **Leave upstream `imageBlocks` in place and only fix the URL** — cheapest, but it is
  always block-below (so `see ![x](d.png) here` breaks the paragraph), it cannot size an
  image, and it has no notion of `![[ … ]]`.

## Consequences

- **`WidgetType.eq()` is keyed on `(src, alt, width, height, placement)`.** Source alone is
  not enough once a size suffix exists, or editing `|300` to `|400` would reuse the old DOM.
  An unrelated edit still produces an `eq` widget, so CodeMirror reuses the element and the
  browser never re-decodes the image — the render-cache lesson ADR-0005 records, in the form
  this field needs it.
- **Upstream's URL-keyed `dimensionCache` is kept, and keeps storing *natural* dimensions.**
  It exists to pin `width`/`height` on remount so a decoded image cannot grow the heightmap
  under an in-flight scroll. An explicit size from a `|` suffix is therefore applied as CSS
  `width`/`height`, never as HTML attributes, so two differently-sized Embeds of one file
  cannot corrupt each other's cache entry.
- **A block widget must come from a `StateField`** (CM6 forbids ViewPlugin-sourced block
  decorations); a point inline widget may come from either. One field serves both, matching
  upstream's structure and this repo's precedent in `mermaid.ts` and `criticMarkupView.ts`.
- **The read-mode click gesture is free**, because in `read` the source is unreachable and
  caret placement is meaningless. It is spent on a lightbox for images the content column
  has downscaled. In `editing` the click stays upstream's caret-to-source, which is the only
  way to reach a source line `inlinePreview` has hidden.
- Pure logic — Embed detection, size parsing, placement choice, cursor overlap — lives in a
  unit-tested plain `.ts` module per the repo convention; the DOM shell is covered by
  Playwright.
