---
type: Concept
title: Sunstone's own CodeMirror extensions
description: The CodeMirror 6 extensions Sunstone writes itself on top of atomic-editor — mermaid, wikilinks, broken links, citations, CriticMarkup, anchor tracking, frontmatter, find and formatting.
tags: [editor, codemirror, extensions, decorations, criticmarkup, mermaid]
timestamp: 2026-07-23
---

# Sunstone's own CodeMirror extensions

On top of the [atomic-editor](/editor/atomic-editor.md) live-preview base, Sunstone writes its own CodeMirror 6 extensions for OKF-specific concerns. They all live in `src/lib/editor/` and are assembled by the [`cm.ts` builder](/editor/codemirror.md).

They follow one house rule (also the repo-wide convention): **pure logic lives in a plain `.ts` module** so it can be unit-tested over strings, and a **thin CM shell** wires it into `StateField`/`ViewPlugin`/`Decoration`. `criticMarkup.ts` (pure) vs `criticMarkupView.ts` (CM wiring), and `mermaidBlocks.ts` (pure detection) vs `mermaid.ts` (CM widget) are the clearest examples; `textFormat.ts`, `review.ts` and `reviewStepper.ts` are pure and imported by command wiring in `cm.ts`/`App.svelte`.

| Extension | File(s) | CM primitive | Purpose |
| --- | --- | --- | --- |
| Mermaid diagrams | `mermaid.ts`, `mermaidBlocks.ts`, `mermaidTheme.ts` | `StateField` + block-replace `WidgetType` | Render ` ```mermaid ` fences as SVG |
| Embedded images | `embeds.ts`, `embedPlan.ts`, `embedLightbox.ts` | `StateField` + point `WidgetType` | Render an Embed's Attachment as an `<img>` |
| Wikilinks | `wiki-links.ts` | atomic `wikiLinks` + overlay `ViewPlugin` | `[[name]]` rendering / navigation |
| Broken links | `broken-links.ts` | `ViewPlugin` + `StateEffect` | Dashed-red styling of unresolved `[](…)` |
| Citations | `citations.ts` | `ViewPlugin` + `WidgetType` + flash `StateField` | `[n]` superscript → jump to citation row |
| CriticMarkup | `criticMarkup.ts`, `criticMarkupView.ts` | `StateField` decorations + `gutter` + `hoverTooltip` | Highlights, comments, track-changes |
| Anchor tracking | `anchor-tracking.ts` | `StateField` + `StateEffect` | Follow heading slugs across edits for rename-rewrite |
| Frontmatter | `frontmatter-field.ts` | `StateField` + `invertedEffects` | Structured frontmatter in unified undo |
| Find & replace | `find.ts` | `@codemirror/search` panel | In-Concept find/replace |
| Formatting | `textFormat.ts` | pure transforms → `cm.ts` commands | Bold/italic/heading/link toggles |
| Review toggle | `review.ts`, `reviewStepper.ts` | pure decision/index logic | Enable + drive the git-diff review view |

## Mermaid diagrams

`mermaidBlocks(reading, theme)` renders ` ```mermaid ` fences as SVG. `mermaidBlocks.ts` is the pure detection layer: it walks the syntax tree (`ensureSyntaxTree` with a 200ms parse budget) for `FencedCode` nodes whose info string is `mermaid`, returning each fence's body and document range; `selectionTouches` decides the hybrid-mode reveal. `mermaid.ts` is the CM shell: a `StateField<DecorationSet>` providing `Decoration.replace({ block: true })` over each fence, driven by a `MermaidWidget` `WidgetType`. atomic-editor exposes no generic block-renderer seam, so this is a _sibling_ field, not a plugin on top of `imageBlocks`/`tables` ([ADR-0005](/adr/0005-mermaid-block-rendering.md)). Notable techniques: mermaid is lazy-loaded (`import('mermaid')`, `securityLevel: 'strict'`) only when the doc has a diagram; a module-level `source→SVG` cache plus a per-host generation token keep repaints cheap and discard stale async renders; `WidgetType.eq()` is keyed on `(source, theme, reading)`; and theme flips go through a [Compartment reconfigure](/editor/codemirror.md) because CM won't reconcile block-widget DOM in place. `mermaidTheme.ts` is CM-free (shared with the web viewer) and maps app CSS variables to concrete mermaid `themeVariables` — concrete values, because mermaid bakes colours into the SVG. It depends on the [patched](/editor/atomic-editor-patch.md) `treeGrowthEffect` re-export to re-render fences parsed after the initial budget.

## Embedded images

`embedBlocks(reading, currentPath)` renders an **Embed** — `![alt](x.png)` or `![[x.png]]` — as the **Attachment** it points at. It **replaces** atomic-editor's `imageBlocks()`, which is dropped from `modeExtensions` so nothing double-renders.

`embedPlan.ts` is the pure layer: given the Embeds the wasm kernel found, it decides placement, render state and widget identity, taking `classify`/`isImage`/`resolve`/`url` as callbacks so it unit-tests over plain strings with no wasm, no index and no backend. `embeds.ts` is the CM shell: one `StateField` emitting exactly one **point** `Decoration.widget` per Embed and **never a replace** ([ADR-0010](/adr/0010-embeds-as-point-widgets-over-inline-preview.md)). Hiding the raw `![alt](x.png)` source, and revealing it under the cursor, is left entirely to `inlinePreview`, which already `Decoration.replace`s the whole `Image` node on inactive lines and honours the patched `alwaysRender` flag in `read` — a deliberate divergence from ADR-0005's block-replace, which was reasoned from mermaid fences being multi-line.

Placement branches on one predicate — is the Embed the only content on its line? Alone → `Decoration.widget({ block: true, side: 1 })` at `line.to`; among text → an inline point widget at the node's end, suppressed while its own line is active (the cursor-overlap skip `citations.ts` and `smartDashesView.ts` use).

Notable techniques:

- **Offsets.** The field scans with `scanEmbedsUtf16`, not `scanEmbeds`. The Embed kernel reports **byte** offsets by default — the unit the SSR renderer and the rewrite engine slice Rust strings with — and CodeMirror positions are **UTF-16 code units**, so a byte offset misplaces every decoration after the first non-ASCII character. The UTF-16 variant lives in `crates/sunstone-shared/src/embed.rs` beside the byte one, the same way `critic.rs` and `citations.rs` already report this seam ([ADR 0006](/adr/0006-wasm-shared-core-for-frontend-logic.md) §4).
- **Sizing.** An explicit `|300` / `300x200` is applied as CSS `width`/`height`, **never** as HTML attributes: those belong to upstream's URL-keyed `dimensionCache`, which stores *natural* dimensions so a remount reserves the right box and a decoding image cannot grow the heightmap mid-scroll. A width above the natural width upscales (Obsidian's behaviour); `max-width: 100%` keeps a size a request the content column may clamp.
- **`eq()`** is keyed on `(render, placement, width, height, alt, src)` — source alone is not enough once sizes exist, or editing `|300` to `|400` would reuse the old DOM. An unrelated edit still yields an equal key, so CodeMirror reuses the element and the browser never re-decodes the image.
- **Click.** In `editing` it is upstream's caret-to-source (`posAtDOM`, resolved at event time, never a captured offset) — the only way to reach a source line `inlinePreview` has hidden. In `read` there is no caret to place, so the gesture buys a **lightbox** for images the content column has downscaled: `embedLightbox.ts` mounts a focus-managed surface on `document.body` (Escape closes, focus trapped while open, restored on close).
- **Two failure visuals, not three.** `embed-broken` (`var(--danger)`, dashed, matching `cm-broken-link`) covers both an unresolvable target and a resolved target whose bytes fail to load — the second needs an `onerror` handler upstream has none of. `embed-remote` is the neutral click-to-load affordance for an `http(s)` Embed, which fetches nothing until clicked; a `data:` URI and a non-image Attachment get no widget at all.
- **One vocabulary with the server render.** The class names (`embed-image` / `embed-broken` / `embed-remote`), the `data-embed-*` attributes and the `<img>` builder (`src/lib/embedImage.ts`) are shared with the shared Rust renderer's output, `src/lib/rendered.css` and `src/lib/web/remoteEmbed.ts`, so the editor and the web/print surfaces cannot drift.

## Wikilinks

`wikiLinksExtension(ctx)` (ADR-0004) renders `[[name]]` by wrapping atomic-editor's `wikiLinks` with a Sunstone adapter: a synchronous name-based resolver (upstream expects async, so it's wrapped in `Promise.resolve`), an in-app `onOpen` that navigates and best-effort scrolls to a `#heading`, and broken-link styling. Because the upstream resolve-cache has no invalidation API, the whole extension is wrapped in the wikilink [Compartment](/editor/codemirror.md) and reconfigured on index change. The one genuinely custom piece is an overlay `ViewPlugin`: upstream styles _all_ aliased links `[[target|label]]` as resolved and never runs `resolve()` on them, so a broken `[[missing|x]]` would look valid — the overlay re-checks aliased targets and marks the label range `cm-atomic-wiki-link-missing` when unresolved.

## Broken links

`brokenLinks(ctx)` is a `ViewPlugin` that walks the syntax tree over the visible ranges for `Link` nodes, resolves each internal `[](…)` target against a synchronous `exists()` predicate (backed by the Bundle index's cached path set), and marks unresolved ones `cm-broken-link` (dashed red). Styling only — links stay clickable. A `refreshBrokenLinks` `StateEffect` (dispatched by `refreshBrokenLinkDecorations`) forces a recompute on external events (file-changed watcher, Concept switch) beyond the normal doc/viewport triggers.

## Citations

`citations(reading)` renders an inline `[n]` that follows a word as a clickable superscript that scrolls to the matching `[n] …` citation row lower in the Concept and flashes it (~1.2s). Two-part architecture: a `ViewPlugin` builds the superscript `Decoration.replace({ widget })` (its `CitationWidget` overrides `ignoreEvent() → false` so the click reaches the DOM handler), and a separate `citationFlashField` `StateField` holds the flash `Decoration.line` so it survives viewport recompute and maps through edits. It relies on the [patch](/editor/atomic-editor-patch.md)'s url-less-`Link` fix (so `[n]` arrives as literal text) and is placed after `inlinePreview` so its replace decoration wins over the stray reference-link syntax colour.

## CriticMarkup

`criticMarkup.ts` is the pure, CM-free model: it parses the five CriticMarkup mark types, pairs a comment to its preceding highlight, and authors the highlight+comment insert/edit/remove edits as CM-shaped `{from,to,insert}` change arrays. `criticMarkupView.ts` is the CM shell: highlight content gets an amber background with hidden `{==`/`==}` delimiters, a bound comment is hidden from the text and surfaced as a left-**gutter** speech-bubble `GutterMarker` plus a `hoverTooltip`, and track-change marks render as red/green tints. Clicking the gutter icon calls the host `onCommentEdit` popup. It is deliberately a **`StateField`, not a `ViewPlugin`** — a comment note can contain line breaks, and a `Decoration.replace` spanning a line boundary is only legal from a state field (a ViewPlugin providing one throws and drops all rendering). This is the single most notable CM-API workaround in the editor. `cm.ts` exposes the imperative authoring surface (`annotate`, `addAnnotationWithComment`, `updateAnnotationComment`, `removeAnnotationAt`) used by both the `Mod-Alt-m` keybinding and the reading-mode popup — the latter dispatches programmatically so annotating works even in read-only `view` mode (the preferred way), reading the range from the DOM selection via `posAtDOM` when CM hasn't synced it.

## Anchor tracking

`anchorTracking` is a `StateField<TrackedHeading[]>` that remaps each heading's line-start position through every change set (`tr.changes.mapPos(pos, 1)`, assoc bias `1` so an insertion at a line start stays with the following heading). It distinguishes a heading **rename** (tracked position still on a heading, slug changed) from a **delete** (position no longer on a heading), so the host can rewrite inbound `#slug` anchors on rename while letting deletes break intentionally. `pendingAnchorRenames` diffs surviving headings against a fresh full-document scan (full scan so GitHub-style de-dup counters stay correct); `commitAnchorBaseline` re-snapshots via a `resetAnchorBaseline` `StateEffect` after each rewrite.

## Frontmatter field and its editor

`frontmatterField` is a `StateField<string>` holding the open Concept's frontmatter as raw YAML **text** — the source of truth while a doc is open, since the CM document itself holds only the markdown body ([ADR-0008](/adr/0008-raw-yaml-frontmatter-editing.md)). `fencesField` carries the verbatim `---` delimiter lines beside it, so a body-only edit re-emits the file byte-for-byte. Both are mutated by `StateEffect`s (`setFrontmatter` / `setFences`).

The text is shown and edited in a **second CodeMirror**, built by `frontmatterEditor.ts` and mounted in the Frontmatter Region. That editor deliberately has **no `history()` of its own**: the body editor owns the single undo stack, this one mirrors the field out and dispatches edits back in, and its `Mod-z`/`Mod-y` bindings forward to `undo(host)`/`redo(host)`. The key trick is **unified undo**: `frontmatterUndo` uses `invertedEffects` to register the inverse `setFrontmatter` for any transaction carrying one, so frontmatter changes reverse on the _same_ undo/redo timeline as body text. It must be ordered immediately after `history()` or undo silently breaks.

Grouping is done by hand because CodeMirror's history only coalesces events that **both** carry document changes — an effect-only transaction always opens its own step, so typing would produce one undo step per keystroke. Intermediate keystrokes therefore go in with `addToHistory: false`, and `commitFrontmatterGroup` opens ONE entry per idle pause, annotated with the value the run started from (`frontmatterGroupStart`) so the inverse skips past every intermediate. The group also closes on blur, on an explicit save, before an undo/redo, and on a Concept switch.

The YAML grammar, its highlighting and the well-formedness linter live in `yamlLanguage.ts` behind a dynamic `import()` and are reconfigured into a `Compartment` when they land — a collapsed Region (the default) never fetches them. Diagnostics there are well-formedness **only**; OKF rules are the marker-gated language service ([ADR-0009](/adr/0009-marker-gated-okf-language-service.md)).

## Find & replace

`findExtensions()` mounts CodeMirror's built-in `@codemirror/search` panel (`search({ top: true })` + `searchKeymap`) above the editor rather than a hand-rolled Svelte panel, giving case/whole-word/regexp toggles and replace/replace-all for free; replace rides ordinary transactions so it inherits autosave and undo. `Ctrl/Cmd+F` is owned app-wide by `App.svelte`, which calls `openSearch(view)`. Since CM's `SearchPanel` class isn't exported, `openSearch` reaches into `view.dom` after the panel renders and tags its fields with `data-testid` attributes for e2e selection — an idempotent DOM-poke. Scope is the body only (frontmatter lives in the field and its own editor, not the document).

## Formatting commands

`textFormat.ts` is pure: `toggleInlineWrap` (`**`/`*`/`` ` ``/`~~`), `insertLink`, `linkAt`, and `headingFormatEdit` (ATX levels 1–6 or plain across the touched lines) all return CM-shaped `{changes, selection}` edits. `cm.ts` wraps them in `Command`s bound in the `formattingKeymap` (`Mod-b/i/e`, `Mod-Shift-m`, `Mod-0…6`), placed before the general keymap so they win, and re-exposes them as imperative functions (`toggleBold`, `insertOrEditLink`, …) for the right-click menu. All are read-only-gated and toggle (re-applying removes) for Obsidian parity.

## Review toggle

`review.ts` decides whether the "Review changes" toggle is enabled (only `status: 'ok'` — a HEAD exists to diff) and the disabled-tooltip text per git status; `reviewStepper.ts` computes which two revs to diff at each stepper position (position 0 = working tree ↔ HEAD with the live buffer as the newer side; position k = `HEAD~(k-1)` ↔ `HEAD~k`). Both are pure; `App.svelte` and the [review buffer builder](/editor/codemirror.md) stay thin over them. The rendered diff is [CriticMarkup](#criticmarkup) shown in read-only `view` mode.
