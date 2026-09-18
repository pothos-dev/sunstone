---
type: Reference
title: atomic-editor — the live-preview dependency
description: The @atomic-editor/editor package that supplies Sunstone's CodeMirror live-preview decoration layer, and which of its extensions Sunstone consumes.
resource: https://www.npmjs.com/package/@atomic-editor/editor
tags: [editor, codemirror, atomic-editor, dependency, live-preview]
timestamp: 2026-07-23
---

# atomic-editor

`@atomic-editor/editor` (pinned at **0.4.3**, MIT) provides the hard, custom part of the [CodeMirror integration](/editor/codemirror.md): the Obsidian-style live-preview decoration layer. Its CM6 extensions are framework-agnostic, so Sunstone consumes them directly and mounts them into a Svelte-managed `EditorView` — the package's React wrapper is not used. Choosing this over hand-rolling live preview (the single largest cost in the project) or a WYSIWYG editor is [ADR-0001](/adr/0001-codemirror-hybrid-live-preview.md).

It is a young, single-maintainer project (Nov 2025). The mitigation is that it is MIT and its extensions are composable, so pieces can be vendored or replaced — which is exactly what the [vendored patch](/editor/atomic-editor-patch.md) does.

## Extensions Sunstone consumes

All are imported in `src/lib/editor/cm.ts` from `@atomic-editor/editor`:

| Export | Role |
| --- | --- |
| `inlinePreview({ onLinkClick, alwaysRender })` | The core live-preview decorator: hides inline markup on inactive lines, renders links, reveals the cursor line. `alwaysRender` is a [Sunstone patch](/editor/atomic-editor-patch.md). |
| `tables({ onLinkClick })` | Renders GFM tables as interactive widgets. |
| `imageBlocks()` | Renders `![alt](url)` image blocks (widget below the one-line source). **Not wired** — Sunstone's own `embedBlocks()` replaces it ([ADR-0010](/adr/0010-embeds-as-point-widgets-over-inline-preview.md)). |
| `atomicMarkdownSyntax` | The markdown syntax-highlighting style. |
| `atomicEditorTheme` | The base editor theme (reads `data-theme` on the CM root for light/dark). |
| `wikiLinks` | `[[name]]` rendering — enabled as an _optional secondary_ format ([ADR-0004](/adr/0004-wikilinks-optional-secondary-name-based.md)), wrapped by [Sunstone's adapter](/editor/custom-extensions.md). |
| `ATOMIC_CODE_LANGUAGES` (`@atomic-editor/editor/code-languages`) | Lazy-loaded fenced-code grammars — each entry's `load()` is a dynamic `import('@codemirror/lang-*')`, so grammars split into their own chunks and only load per language actually used. |
| `treeGrowthEffect`, `treeProgressPlugin` | Signal that budgeted parsing has advanced; used by [`mermaidBlocks`](/editor/custom-extensions.md) to re-render fences parsed after the initial parse window. **Only reachable via the [patch](/editor/atomic-editor-patch.md)** — upstream doesn't export them from the root. |

The GFM parser wiring — `markdown({ base: markdownLanguage, codeLanguages: ATOMIC_CODE_LANGUAGES })` — is the keystone: without `base: markdownLanguage` the parser is pure CommonMark and inline-preview never sees Task/Table nodes; without `codeLanguages` fenced blocks have no grammar to highlight.

## What Sunstone does NOT take from atomic-editor

- **Primary link resolution.** OKF uses standard markdown links (`/abs.md`, `./rel.md`), resolved by path; Sunstone writes its own [broken-link](/editor/custom-extensions.md) styling and OKF navigation rather than atomic-editor's link model. `wikiLinks` is the deliberate exception, and only for the secondary name-based format.
- **A generic block-renderer seam.** atomic-editor exposes no generic block extension point — each block type (`tables`, `imageBlocks`) is a dedicated field — so [mermaid rendering](/editor/custom-extensions.md) is written as a _sibling_ `StateField` alongside them, not on top of them ([ADR-0005](/adr/0005-mermaid-block-rendering.md)).

Sunstone's own extensions that layer on top of this base are documented in [custom CodeMirror extensions](/editor/custom-extensions.md); the local modifications to this package are in the [vendored patch](/editor/atomic-editor-patch.md).
