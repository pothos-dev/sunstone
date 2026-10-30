---
type: Concept
title: Sunstone's own CodeMirror extensions
description: The CodeMirror 6 extensions Sunstone writes itself on top of atomic-editor — diagrams (mermaid, D2, PlantUML), wikilinks, broken links, citations, CriticMarkup, anchor tracking, frontmatter, find and formatting.
tags: [editor, codemirror, extensions, decorations, criticmarkup, mermaid, d2, plantuml, diagrams]
generated: { by: claude-code/unknown, at: 2026-10-30T13:40:47+01:00 }
---

# Sunstone's own CodeMirror extensions

On top of the [atomic-editor](/editor/atomic-editor.md) live-preview base, Sunstone writes its own CodeMirror 6 extensions for OKF-specific concerns. They all live in `src/lib/editor/` and are assembled by the [`cm.ts` builder](/editor/codemirror.md).

They follow one house rule (also the repo-wide convention): **pure logic lives in a plain `.ts` module** so it can be unit-tested over strings, and a **thin CM shell** wires it into `StateField`/`ViewPlugin`/`Decoration`. `criticMarkup.ts` (pure) vs `criticMarkupView.ts` (CM wiring), and `diagramBlocks.ts` (pure detection) vs `diagram.ts` (CM widget) are the clearest examples; `textFormat.ts`, `review.ts` and `reviewStepper.ts` are pure and imported by command wiring in `cm.ts`/`App.svelte`.

| Extension | File(s) | CM primitive | Purpose |
| --- | --- | --- | --- |
| Diagrams | `diagram.ts`, `diagramBlocks.ts`, `diagramRender.ts`, `diagramLanguage.ts`, `diagramLanguages.ts`; mermaid in `mermaidLanguage.ts`, `mermaidTheme.ts`; D2 in `d2Language.ts`, `d2Worker.ts`, `d2Engine.ts`, `d2Theme.ts`; PlantUML in `plantumlLanguage.ts`, `plantumlEngine.ts`, `plantumlTheme.ts` | `StateField` + block-replace `WidgetType` | Render diagram fences (` ```mermaid `, ` ```d2 `, ` ```plantuml `) as SVG |
| Embedded images | `embeds.ts`, `embedPlan.ts`, `embedLightbox.ts` | `StateField` + point `WidgetType` | Render an Embed's Attachment as an `<img>` |
| Wikilinks | `wiki-links.ts` | atomic `wikiLinks` + overlay `ViewPlugin` | `[[name]]` rendering / navigation |
| Broken links | `broken-links.ts` | `ViewPlugin` + `StateEffect` | Dashed-red styling of unresolved `[](…)` |
| Citations (deprecated) | `citations.ts` | `ViewPlugin` + `WidgetType` + flash `StateField` | v0.1 `[n]` superscript → jump to citation row |
| Footnotes | `footnotes.ts` | `ViewPlugin` + `WidgetType` (shares the citation flash field) | `[^label]` superscript → open its source, or jump to `[^label]:` definition |
| Contract card | `computation.ts` | `StateField` + block `WidgetType` | An Attested Computation's contract above the first line; path fields open via `onLinkClick` |
| Computation section | `computation.ts` | `StateField` line decorations | An Attested Computation's `# Computation` section, set apart (ov-13) |
| Sources section | `sources.ts` | `StateField` + block `WidgetType`; block-replace `StateField` | The `sources` list as a bibliography after the last line; hides body definitions for `sources` ids |
| CriticMarkup | `criticMarkup.ts`, `criticMarkupView.ts` | `StateField` decorations + `gutter` + `hoverTooltip` | Highlights, comments, track-changes |
| Anchor tracking | `anchor-tracking.ts` | `StateField` + `StateEffect` | Follow heading slugs across edits for rename-rewrite |
| Frontmatter | `frontmatter-field.ts` | `StateField` + `invertedEffects` | Structured frontmatter in unified undo |
| Frontmatter folding | `yamlFold.ts` → `frontmatterEditor.ts` | `foldService` + `codeFolding` + `foldGutter` | Fold YAML blocks; `sources`/`verified` start folded |
| Find & replace | `find.ts` | `@codemirror/search` panel | In-Concept find/replace |
| Formatting | `textFormat.ts` | pure transforms → `cm.ts` commands | Bold/italic/heading/link toggles |
| Review toggle | `review.ts`, `reviewStepper.ts` | pure decision/index logic | Enable + drive the git-diff review view |

## Diagrams

`diagramBlocks(reading, theme)` (`diagram.ts`) renders diagram fences as SVG, for every language registered in `diagramLanguages.ts`: ` ```mermaid `, ` ```d2 ` and ` ```plantuml ` ([ADR-0005](/adr/0005-mermaid-block-rendering.md), amended by [ADR-0014](/adr/0014-diagram-languages-share-one-block-renderer.md)). The pipeline is split into a language-agnostic seam and one small module per language:

| File | Role |
| --- | --- |
| `diagramLanguage.ts` | Pure, CM- and DOM-free. The `DiagramLanguage` contract, `findDiagramLanguage` (info string → language), `diagramCacheKey(language, source, theme)` and `languageCacheKey` (which drops the theme for a stylesheet-themed language), the `rendererFor` lazy-loader memo, `diagramClasses` |
| `diagramLanguages.ts` | The registry: `DIAGRAM_LANGUAGES`, one line per language. Editor, web viewer and print all read it |
| `diagramBlocks.ts` | Pure detection over the CM tree: `findDiagramBlocks` (`ensureSyntaxTree`, 200ms budget) returns each fence's language, body and range; `selectionTouches` decides the reveal while `editing` |
| `diagramRender.ts` | The DOM render engine shared by the editor and the web island: placeholder, error panel, `(language, source, theme) → SVG` cache, per-host generation token, the `sanitise` hook, the language stylesheet |
| `diagram.ts` | The CM shell: a `StateField<DecorationSet>` providing `Decoration.replace({ block: true })` over each fence, a `DiagramWidget` with the double-click / hover-hint edit affordance, and the shared `cm-diagram-*` styles |
| `mermaidLanguage.ts` | Mermaid: the only module that imports `mermaid` or sets `securityLevel: 'strict'` |
| `mermaidTheme.ts` | Mermaid's renderer input: app CSS variables → concrete mermaid `themeVariables` (concrete, because mermaid bakes colours into the SVG) |
| `mermaidBlocks.ts` | Mermaid-only views (`findMermaidBlocks`, `hasMermaidBlock`) over the generic detection |
| `d2Language.ts` | D2: spawns `d2Worker.ts` on the first ` ```d2 ` render, sends it `{ id, source, salt }`, sanitises the result with `svg/sanitiseSvg.ts` |
| `d2Worker.ts` | The Web Worker around `@terrastruct/d2`'s browser build (which inlines `d2.wasm` and starts a nested worker of its own); its own build chunk, fetched only on demand |
| `d2Engine.ts` | Pure: the render options forced on every D2 diagram (theme 0, per-render `salt`, `scale: 1`, small `pad`), D2 error-message cleanup |
| `plantumlLanguage.ts` | PlantUML: dynamic-imports `@plantuml/core` and viz.js on the first ` ```plantuml ` render (main thread; the engine needs a DOM), switches off the engine's `<script>` loader, imports the icon table (and the emoji table only when a source uses one), renders one at a time, sanitises with `svg/sanitiseSvg.ts` |
| `plantumlEngine.ts` | Pure: wraps a bare body in `@startuml`, inserts the palette preamble after the `@start…` line, turns the engine's error pictures into `line N: message` (N in the fence) |
| `plantumlTheme.ts` | Pure: app CSS variables → a PlantUML `<style>` block with concrete `#RRGGBB` colours (translucent tokens composited over the surface) |
| `serialQueue.ts` | A one-at-a-time call queue for engines with shared state (D2, PlantUML) |
| `d2Theme.ts` | Pure: D2's colour-slot classes (`fill-N1`, `stroke-B1`, …) → app CSS variables, emitted as one scoped stylesheet that out-ranks D2's embedded `<style>` |

A language is a `DiagramLanguage` object: `id` (the fence info string, lower-case; it also names the language's CSS classes and the web error panel's `data-testid`, `<id>-error`), `load()` (a dynamic `import()` of the engine that resolves to a `DiagramRenderer`, `({ source, theme, read, renderId }) => Promise<svg>`, rejecting with the message the error panel shows), `sanitise(svg)` (required; dr-2's sanitiser plugs in here, mermaid passes `identity`), an optional scoped `stylesheet` injected once, and an optional `themedByStylesheet` flag for a language whose SVG is theme-independent because the stylesheet colours it (D2): its cache entry is shared by both themes, so a theme flip repaints from the cache and never re-renders. `renderId` is unique per render, usable as a DOM id (mermaid) or an id salt. Adding a language is that module plus a line in `diagramLanguages.ts`.

Every element the seam creates carries a generic class (styled once) and the language's own: `cm-diagram cm-mermaid`, `cm-diagram-error cm-mermaid-error`, on the web `web-diagram-render web-mermaid-render`. atomic-editor exposes no generic block-renderer seam, so the field is a _sibling_ of `imageBlocks`/`tables`, not a plugin on top of them. Notable techniques: a language's engine loads only when a fence in it renders; the module-level cache plus the per-host generation token keep repaints cheap and discard stale async renders; `WidgetType.eq()` is keyed on `(language, source, theme, reading)`; and theme flips (`setEditorDiagramTheme`) go through a [Compartment reconfigure](/editor/codemirror.md) because CM won't reconcile block-widget DOM in place. The field depends on the [patched](/editor/atomic-editor-patch.md) `treeGrowthEffect` re-export to re-render fences parsed after the initial budget. The web viewer and the print path hydrate the server's inert `<pre><code class="language-<id>">` blocks through `web/webDiagram.ts` (`hydrateDiagrams`), over the same engine and registry; print forces the light theme (mermaid and PlantUML render with `light` and read the light palette the print sheet declares; D2's stylesheet reads it at paint time).

## Embedded images

`embedBlocks(reading, currentPath)` renders an **Embed** — `![alt](x.png)` or `![[x.png]]` — as the **Attachment** it points at. It **replaces** atomic-editor's `imageBlocks()`, which is dropped from `modeExtensions` so nothing double-renders.

`embedPlan.ts` is the pure layer: given the Embeds the wasm kernel found, it decides placement, render state and widget identity, taking `classify`/`isImage`/`resolve`/`url` as callbacks so it unit-tests over plain strings with no wasm, no index and no backend. `embeds.ts` is the CM shell: one `StateField` emitting exactly one **point** `Decoration.widget` per Embed and **never a replace** ([ADR-0010](/adr/0010-embeds-as-point-widgets-over-inline-preview.md)). Hiding the raw `![alt](x.png)` source, and revealing it under the cursor, is left entirely to `inlinePreview`, which already `Decoration.replace`s the whole `Image` node on inactive lines and honours the patched `alwaysRender` flag in `read` — a deliberate divergence from ADR-0005's block-replace, which was reasoned from mermaid fences being multi-line.

Placement branches on one predicate — is the Embed the only content on its line? Alone → `Decoration.widget({ block: true, side: 1 })` at `line.to`; among text → an inline point widget at the node's end, suppressed while its own line is active (the cursor-overlap skip `citations.ts` and `smartDashesView.ts` use).

Notable techniques:

- **Offsets.** The field scans with `scanEmbedsUtf16`. The Embed kernel reports **byte** offsets natively — the unit the SSR renderer and the rewrite engine slice Rust strings with — and CodeMirror positions are **UTF-16 code units**, so a byte offset misplaces every decoration after the first non-ASCII character. The UTF-16 variant lives in `crates/sunstone-shared/src/embed.rs` beside the byte one, the same way `critic.rs` and `citations.rs` already report this seam ([ADR 0006](/adr/0006-wasm-shared-core-for-frontend-logic.md) §4).
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

**Deprecated** ([ADR 0013](/adr/0013-per-claim-attribution-by-source-id.md)): the `[n]` form is v0.1 attribution, still read so v0.1 Bundles work, but nothing new should be written in it. Cite with a `[^id]` footnote against `sources` ([Footnotes](#footnotes)).

`citations(reading)` renders an inline `[n]` that follows a word as a clickable superscript that scrolls to the matching `[n] …` citation row lower in the Concept and flashes it (~1.2s). Two-part architecture: a `ViewPlugin` builds the superscript `Decoration.replace({ widget })` (its `CitationWidget` overrides `ignoreEvent() → false` so the click reaches the DOM handler), and a separate `jumpFlashField` `StateField` (`jumpFlash.ts`) holds the flash `Decoration.line` so it survives viewport recompute and maps through edits. It relies on the [patch](/editor/atomic-editor-patch.md)'s url-less-`Link` fix (so `[n]` arrives as literal text) and is placed after `inlinePreview` so its replace decoration wins over the stray reference-link syntax colour.

## Footnotes

`footnotes(reading)` does the same for markdown footnotes over the shared `scanFootnotes` kernel: a `[^label]` reference becomes a superscript `n` (numbered by first reference, label on hover, `,n` when it directly follows another) that jumps to its `[^label]:` definition through the shared `jumpAndFlash` (installing `jumpFlashField` too, which CodeMirror dedupes), each definition marker becomes an `n` row head, and a reference with no definition renders dashed red and ignores clicks. A label matching a `sources[].id` (read from `frontmatterField` through `sourceList`) counts as resolved without a body definition; it shows the entry on hover and a click hands its `resource` to `onLinkClick`, the same callback rendered links use, so a path opens in the Tile and a URL in the browser. `sourcesSection(onLinkClick, onEditSource)` adds the Sources section as a block widget at the end of the document; a block decoration must come from a `StateField`, not a `ViewPlugin`. Each entry shows its signals, a hidden definition's text, back-jumps to its citing claims (through `jumpAndFlash`) and, when the host passes `onEditSource`, an Edit button that hands the entry's list index to the Tile, which opens the Frontmatter Region on it (`FrontmatterEditor.revealSource`, over the pure `sourceEntry.ts`). `hiddenSourceDefs(reading)` block-replaces the line of each `[^id]:` definition whose label is a `sources` id (always in reading mode; while editing unless the selection touches it), and `footnotes.ts` draws no row head for those. In hybrid mode a reference shows raw under the cursor and a definition marker shows raw while the cursor is on its line. See [Linking → Footnotes](/okf/linking.md#footnotes).

## CriticMarkup

`criticMarkup.ts` is the pure, CM-free model: it parses the five CriticMarkup mark types, pairs a comment to its preceding highlight, and authors the highlight+comment insert/edit/remove edits as CM-shaped `{from,to,insert}` change arrays. `criticMarkupView.ts` is the CM shell: highlight content gets an amber background with hidden `{==`/`==}` delimiters, a bound comment is hidden from the text and surfaced as a left-**gutter** speech-bubble `GutterMarker` plus a `hoverTooltip`, and track-change marks render as red/green tints. Clicking the gutter icon calls the host `onCommentEdit` popup. It is deliberately a **`StateField`, not a `ViewPlugin`** — a comment note can contain line breaks, and a `Decoration.replace` spanning a line boundary is only legal from a state field (a ViewPlugin providing one throws and drops all rendering). This is the single most notable CM-API workaround in the editor. `cm.ts` exposes the imperative authoring surface (`annotate`, `addAnnotationWithComment`, `updateAnnotationComment`, `removeAnnotationAt`) used by both the `Mod-Alt-m` keybinding and the reading-mode popup — the latter dispatches programmatically so annotating works even in read-only `view` mode (the preferred way), reading the range from the DOM selection via `posAtDOM` when CM hasn't synced it.

## Anchor tracking

`anchorTracking` is a `StateField<TrackedHeading[]>` that remaps each heading's line-start position through every change set (`tr.changes.mapPos(pos, 1)`, assoc bias `1` so an insertion at a line start stays with the following heading). It distinguishes a heading **rename** (tracked position still on a heading, slug changed) from a **delete** (position no longer on a heading), so the host can rewrite inbound `#slug` anchors on rename while letting deletes break intentionally. `pendingAnchorRenames` diffs surviving headings against a fresh full-document scan (full scan so GitHub-style de-dup counters stay correct); `commitAnchorBaseline` re-snapshots via a `resetAnchorBaseline` `StateEffect` after each rewrite.

## Frontmatter field and its editor

`frontmatterField` is a `StateField<string>` holding the open Concept's frontmatter as raw YAML **text** — the source of truth while a doc is open, since the CM document itself holds only the markdown body ([ADR-0008](/adr/0008-raw-yaml-frontmatter-editing.md)). `fencesField` carries the verbatim `---` delimiter lines beside it, so a body-only edit re-emits the file byte-for-byte. Both are mutated by `StateEffect`s (`setFrontmatter` / `setFences`).

The text is shown and edited in a **second CodeMirror**, built by `frontmatterEditor.ts` and mounted in the Frontmatter Region. That editor deliberately has **no `history()` of its own**: the body editor owns the single undo stack, this one mirrors the field out and dispatches edits back in, and its `Mod-z`/`Mod-y` bindings forward to `undo(host)`/`redo(host)`. The key trick is **unified undo**: `frontmatterUndo` uses `invertedEffects` to register the inverse `setFrontmatter` for any transaction carrying one, so frontmatter changes reverse on the _same_ undo/redo timeline as body text. It must be ordered immediately after `history()` or undo silently breaks.

Grouping is done by hand because CodeMirror's history only coalesces events that **both** carry document changes — an effect-only transaction always opens its own step, so typing would produce one undo step per keystroke. Intermediate keystrokes therefore go in with `addToHistory: false`, and `commitFrontmatterGroup` opens ONE entry per idle pause, annotated with the value the run started from (`frontmatterGroupStart`) so the inverse skips past every intermediate. The group also closes on blur, on an explicit save, before an undo/redo, and on a Concept switch.

**Folding (ov-15).** The YAML editor folds by indentation: `yamlFold.ts` is the pure line logic (a line folds when the lines after it are indented deeper, or when it is a bare `key:` over a same-indent `- ` list), and `frontmatterEditor.ts` wraps it in a `foldService`, a fold gutter and a placeholder that summarises the block (`3 entries`, `2 keys`, `4 lines`). It is loaded with the editor, not with the lazy grammar, because `@codemirror/lang-yaml` only folds flow collections. Top-level `sources` and `verified` start folded: `foldDefaults()` runs when the editor is built and again when the Tile loads a different Concept (it bumps a `concept` counter the Region watches), but not on undo/redo or reload, so a block the author opened stays open. Folds are view state only and never touch the YAML or the history.

The YAML grammar, its highlighting, the linter and completion live in `yamlLanguage.ts` behind a dynamic `import()` and are reconfigured into a `Compartment` when they land — a collapsed Region (the default) never fetches them.

**Language service (ov-3, [ADR-0009](/adr/0009-marker-gated-okf-language-service.md)).** Both halves live under `src/lib/okf/` and are unit-tested without an editor. `lintFrontmatter(yaml, mode)` (`lint.ts`) is a thin seam onto the Rust lint (`sunstone_shared::okf_lint` over wasm, [ADR-0017](/adr/0017-frontmatter-lint-lives-in-rust-for-sunstone-lint.md), the same rules `sunstone lint` runs): it parses once and returns findings with UTF-16 offsets, in mode `'yaml'` only parse errors and duplicate keys, in mode `'okf'` also the OKF families. `completeFrontmatter(yaml, pos, mode)` (`complete.ts`) works out the key path at the cursor from indentation (the block is half-typed whenever completion is wanted) and returns what the families offer there; it returns nothing outside `'okf'`. The mode comes from `frontmatterLintMode` (`mode.ts`): `'okf'` only when `indexStore.okfVersion()` is non-null, the file is inside the Bundle root, and it is not a reserved `index.md`/`log.md`. The Tile derives it on every index refresh and the editor holds it in `lintModeField` (`editor/lintModeField.ts`); the linter's `needsRefresh` re-runs on a mode change, so adding or removing the marker re-lints without the YAML changing. The save gate (`isParseable`) never consults the lint.

Rules and completions come from **families**, never from a switch in the engine. Each family is an `OkfFamily` (`okf/family.ts`) in its own module under `okf/families/`, listed once in `okf/families/index.ts`:

- `keys` — top-level keys that opt a Concept into the family; `[]` means always on (the §4.1 `core`). A family whose keys are all absent is skipped, which is how a Concept with no `sources` gets no provenance findings.
- `required` — `{ path, key, spec }` entries the engine reports as **errors** when missing or empty; `path` uses `'*'` for every list item (`['sources', '*']`).
- `rules` — `(ctx: RuleContext) => Finding[]` for everything else (warnings or info). `ctx` gives the parsed `root` map, `pair()`, `nodesAt(path)` with anchor ranges, and `at(range, severity, message)`.
- `completions` — `{ path, keys?, values? }`. `path: []` keys are offered in every OKF Concept; nested paths only match once the family's key is present.

`core`, `provenance`, `trust` and `lifecycle` exist today with only their opt-in keys, the spec's REQUIRED fields and key completions; their own rules and value completions arrive with ov-9, ov-10 and ov-11 in those modules.

## Find & replace

`findExtensions()` mounts CodeMirror's built-in `@codemirror/search` panel (`search({ top: true })` + `searchKeymap`) above the editor rather than a hand-rolled Svelte panel, giving case/whole-word/regexp toggles and replace/replace-all for free; replace rides ordinary transactions so it inherits autosave and undo. `Ctrl/Cmd+F` is owned app-wide by `App.svelte`, which calls `openSearch(view)`. Since CM's `SearchPanel` class isn't exported, `openSearch` reaches into `view.dom` after the panel renders and tags its fields with `data-testid` attributes for e2e selection — an idempotent DOM-poke. Scope is the body only (frontmatter lives in the field and its own editor, not the document).

## Formatting commands

`textFormat.ts` is pure: `toggleInlineWrap` (`**`/`*`/`` ` ``/`~~`), `insertLink`, `linkAt`, and `headingFormatEdit` (ATX levels 1–6 or plain across the touched lines) all return CM-shaped `{changes, selection}` edits. `commands.ts` wraps them in `Command`s that `extensions.ts` runs from a high-precedence keydown handler, by the user's rebindable shortcuts (`settings.keybindings`, see `settings/keybindings.ts`: `Mod-b/i/e`, `Mod-Shift-m`, `Mod-1…6`; Paragraph ships unbound because `Mod-0` is Reset zoom). The shortcuts are looked up at keydown time, so a rebinding applies to open editors at once. `cm.ts` re-exposes them as imperative functions (`toggleBold`, `insertOrEditLink`, …) for the right-click menu. All are read-only-gated and toggle (re-applying removes) for Obsidian parity.

## Review toggle

`review.ts` decides whether the "Review changes" toggle is enabled (only `status: 'ok'` — a HEAD exists to diff) and the disabled-tooltip text per git status; `reviewStepper.ts` computes which two revs to diff at each stepper position (position 0 = working tree ↔ HEAD with the live buffer as the newer side; position k = `HEAD~(k-1)` ↔ `HEAD~k`). Both are pure; `App.svelte` and the [review buffer builder](/editor/codemirror.md) stay thin over them. The rendered diff is [CriticMarkup](#criticmarkup) shown in read-only `view` mode.
