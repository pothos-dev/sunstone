# CodeMirror 6 hybrid live preview via atomic-editor

We build the editor on **CodeMirror 6 with Obsidian-style hybrid live preview** (markdown
source is the source of truth; inactive lines render styled, the cursor line shows raw
markup) rather than a true-WYSIWYG editor (Milkdown/Tiptap on ProseMirror). The live-preview
decoration layer — the hard, custom part — is provided by **`@atomic-editor/editor`** (MIT),
whose CM6 extensions (live-preview decorations, table/image widgets, lazy syntax
highlighting) we consume directly; we skip its React wrapper since CM6 extensions are
framework-agnostic and mount into a Svelte-managed `EditorView`. On top we write our own thin
OKF-specific link and frontmatter extensions.

## Considered Options

- **CM6 hybrid (chosen)** — most faithful to "Obsidian-like"; markdown stays the on-disk truth.
- **Milkdown / Tiptap WYSIWYG** — less custom work but hides markup and, for Tiptap, round-trips
  markdown through a non-markdown document model (lossy risk for frontmatter and OKF quirks).
- **Bespoke live preview on raw `@codemirror/*`** — full control but the single largest cost in
  the project; `@atomic-editor/editor` already solves it.

## Consequences

- We take a dependency on a young (Nov 2025), single-maintainer project. Mitigation: it's MIT
  and its extensions are composable, so we can vendor or replace pieces if it stalls.
- atomic-editor ships `[[wiki link]]` support, but OKF uses standard markdown links
  (`/abs.md`, `./rel.md`), so we do not use its link extension for the primary format — we
  write our own. (Wikilinks are later supported as an *optional secondary* format, re-enabling
  this extension; see [ADR-0004](0004-wikilinks-optional-secondary-name-based.md).)

## Update: boolean `editing` view mode + Edit toggle

The view mode is a **boolean** — `editing` vs `read` — surfaced as a single **Edit** toggle in
the [Concept header](/interface/activity-rail.md) (per Tile). A Concept **opens in `read`**;
pressing Edit switches to `editing`. There is no raw-source mode.

- **`editing`** — Obsidian-style live preview: inactive lines render, the cursor line reveals
  raw markup. Editable; undo/redo are available (and shown in the Concept header only here).
- **`read`** — every line renders with no raw markup, and the document is read-only.

The mode-dependent extensions (decorations + `readOnly`/`editable` facets) live in a CodeMirror
`Compartment`, so `setEditorMode` switches modes by reconfiguring it in place — no view rebuild,
so the document, history and selection survive the switch. The mode is remembered per view and
carries across Concept switches. See `src/lib/editor/cm.ts` (`EditorMode`, `modeExtensions`,
`setEditorMode`).

This **supersedes an earlier tri-state design** (a Source / Live / Read toggle mirroring
Obsidian's three modes, in a since-deleted global nav bar). The `edit`/Source mode was dropped
and Live/Read collapsed to the `editing`/`read` boolean; the default flipped from Live to
`read`. Legacy persisted values migrate — `edit`/`hybrid` → `editing`, `view` → `read` — in
`layoutPersist.ts` (`migrateEditorMode`), covering both the session mode and every per-Tile
mode.

Reading view requires telling `inlinePreview` to render *every* line regardless of cursor
position. Upstream atomic-editor hardcodes the "reveal the active line" rule, so we extend our
existing vendored patch (`patches/@atomic-editor%2Feditor@0.4.3.patch`) with an `alwaysRender`
config flag on `inlinePreview` that, when set, treats no line as active.

For how the integration is assembled and what each extension does, see the
[editor concept pages](/editor/index.md): the [CodeMirror integration](/editor/codemirror.md),
the [atomic-editor dependency](/editor/atomic-editor.md), the
[vendored patch](/editor/atomic-editor-patch.md), and
[Sunstone's own extensions](/editor/custom-extensions.md).
