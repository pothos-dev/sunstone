---
status: done
priority: 3
---

# dr-1: Diagram fences render through one language-agnostic block seam

**What to build:** the mermaid pipeline split into a generic diagram-block field and a
mermaid language that plugs into it. A language supplies two things: a lazy loader, and a
renderer that takes source plus resolved theme and returns an SVG string or an error message.
Everything else lives once, in the generic half, and applies to every language registered on
it. Mermaid becomes the first registered language, and from the outside nothing changes.

Today the split runs the other way. `mermaid.ts` (the CodeMirror field and widget),
`mermaidBlocks.ts` (fence detection and `selectionTouches`), `mermaidRender.ts` (lazy load,
cache, generation token, placeholder, error panel) and `webMermaid.ts` (the web island, also
used by `PrintView.svelte`) all hard-code the `mermaid` info string and the `mermaid` module.
A second language would mean copying all four. This ticket makes the copy unnecessary before
[dr-3](dr-3-d2-fences-render-as-diagrams.md) needs it.

The generic half owns:

- Fence detection by info string, matched against the registered languages, with the
  existing parse budget and the `treeGrowthEffect` rebuild for fences parsed late.
- The `Decoration.replace({ block: true })` over the whole fence, the reveal when the cursor
  enters it in `editing`, and the always-rendered `read` mode.
- Double-click to edit and the hover hint.
- The loading placeholder and the bordered error panel, which shows the language's error
  message.
- The module-level render cache, keyed on `(language, source, resolved theme)`.
- The per-host generation token that discards a stale async result.
- The theme-change rebuild. On desktop that is the mode Compartment reconfigure that
  `setEditorMermaidTheme` (`cm.ts`) performs today, renamed to cover every language; on web
  it is the island re-hydrating.
- The lazy gate: a language's loader runs only when the document holds a fence in that
  language.

- [x] A diagram language is a small object (info string, loader, renderer) registered on the
      generic field; the field, widget, cache, generation token, placeholder and error panel
      contain no language name
- [x] Mermaid is registered as the first language and its renderer is the only code that
      imports `mermaid` or knows about `securityLevel: 'strict'`
- [x] The render cache key includes the language, so the same source in two languages never
      shares an entry
- [x] A language's loader is never called for a document with no fence in that language
- [x] The web island (`webMermaid.ts`) and the print path (`PrintView.svelte`) hydrate through
      the same registry, so a language registered once renders in the reader and on paper
- [x] Pure logic (fence detection, language lookup, cache key, cursor overlap) stays in plain
      `.ts` modules with unit tests
- [x] Every existing mermaid unit test and every mermaid Playwright spec
      (`tests/mermaid-*.spec.ts`, the mermaid cases in `tests/web-viewer.spec.ts` and
      `tests/embed-render-caching.spec.ts`) passes unmodified; only import paths may change
- [x] Existing CSS class names and `data-testid`s on mermaid widgets keep working, since those
      specs select on them
- [x] `docs/editor/custom-extensions.md` describes the generic field and the mermaid language
      in place of the mermaid-only description
- [x] All four gates green

## Decisions

- **No behaviour change is the acceptance bar.** This is a refactor. If a mermaid spec has to
  change to pass, the refactor changed behaviour and is wrong, so the tests stay as they are.
- **The theme stays in the cache key for every language.** dr-3 themes D2 by CSS, so the
  theme part of its key does nothing useful, but one key shape for all languages is simpler
  than a per-language flag, and the cost is one extra render per theme.
- **Naming.** The generic modules take a `diagram` prefix (`diagramBlocks.ts`,
  `diagramRender.ts`, `webDiagram.ts`); mermaid-specific code keeps its `mermaid` prefix.
  `mermaidTheme.ts` stays as it is, since it is mermaid's renderer input.

## Comments

- Landed. The seam: `editor/diagramLanguage.ts` (the `DiagramLanguage` type, `findDiagramLanguage`,
  `diagramCacheKey`, the `rendererFor` loader memo, `diagramClasses`), `diagramLanguages.ts` (the
  registry), `diagramBlocks.ts` (detection), `diagramRender.ts` (engine), `diagram.ts` (CM field +
  widget), `web/webDiagram.ts` (`hydrateDiagrams`, used by `WebReader` and `PrintView`). Mermaid is
  `mermaidLanguage.ts`. A language is `{ id, load, sanitise, stylesheet? }`: `load()` resolves to a
  `DiagramRenderer` (`{ source, theme, read, renderId } → Promise<svg>`, rejecting with the error
  message); `sanitise` is required and is where dr-2 plugs in (mermaid passes `identity`);
  `stylesheet` is optional scoped CSS injected once (mermaid's forced app font; D2's slot-class
  palette can go there); `renderId` is unique per render and can serve as D2's `salt`. dr-3 adds
  `d2Language.ts` and one line in `diagramLanguages.ts`. Elements carry a generic class plus the
  language class (`cm-diagram-error cm-mermaid-error`), so existing selectors keep working.
  `setEditorMermaidTheme` is now `setEditorDiagramTheme`. `mermaidBlocks.ts` survives as
  mermaid-only views over the generic detection, and `mermaidCacheKey` stays as mermaid's
  `(source, theme)` identity, because the unchanged mermaid unit tests import them. Mermaid
  Playwright specs (desktop `mermaid-*`, `live-preview`, `embed-render-caching`; web
  `web-viewer`) pass unchanged. No Playwright spec covers the print path.
