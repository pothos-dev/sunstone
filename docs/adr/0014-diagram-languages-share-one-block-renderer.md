# Diagram languages share one block renderer; D2 renders from its WASM build

> Amended by [ADR-0016](0016-plantuml-renders-in-the-browser-from-its-teavm-build.md):
> PlantUML is the third language, rendered from its TeaVM build on the main thread.

A **[Diagram](/GLOSSARY.md)** is rendered by **one** CodeMirror block field and **one** web
island, whatever language its fence is in. A diagram language plugs in as a small object: the
fence info string, a lazy loader, and a renderer that turns source plus resolved theme into an
SVG string or an error message. Fence detection, the block-replace and reveal, double-click to
edit, the hover hint, the error panel, the `(language, source, theme)` render cache, the
stale-generation discard and the theme rebuild are written once. Mermaid is the first language;
**D2** is the second.

This amends [ADR-0005](0005-mermaid-block-rendering.md). Everything that ADR decided about
*how* a Diagram renders (block-replace over the fence, lazy load, theme sync by rebuild, the
render cache) still holds. What changes is that it now applies to every diagram language, not
mermaid alone. ADR-0005 built a sibling field because atomic-editor had no block-renderer seam;
this ADR builds that seam inside Sunstone, for diagrams.

D2 renders client-side from the official WASM build (`@terrastruct/d2`), loaded only when a
document holds a ` ```d2 ` fence, in both shells. Its output is themed by scoped CSS that maps
D2's colour-slot classes to the app's custom properties. Every diagram SVG we inline, D2's
first, passes one shared sanitiser built on DOMPurify.

## Considered Options

- **One renderer, languages plug in (chosen).** A second language costs a loader, a renderer
  and a theme mapping. The alternative was copying four mermaid modules per language and
  keeping the copies in step.
- **D2 from its WASM build, client-side (chosen).** The same code runs on desktop, in
  `sunstone serve`, and in the anonymous web reader's browser, which is where `webMermaid.ts`
  already renders mermaid.
- **Shell out to the `d2` CLI from Rust.** Rejected. It adds a Go binary to every install, and
  the web reader renders in a browser that has no Rust side to call.
- **Render D2 in `sunstone-server`.** Rejected for now, for the same reason in a different
  shape: the server is Rust, D2 is Go, and the desktop would still need its own path.
- **Kroki or another remote rendering service.** Rejected. Opening a Concept would send its
  diagram source over the network, and rendering would fail offline.
- **Theme via CSS overrides of D2's slot classes (chosen).** D2 puts themed colours in classes
  (`fill-N1`, `stroke-B1`, ...) and authored colours in literal attributes, so a scoped
  stylesheet recolours the first and leaves the second alone, and a theme toggle needs no
  re-render.
- **Theme via prepended `theme-overrides` vars and a re-render, like mermaid.** Works (verified),
  and is the fallback if our rules cannot outrank D2's embedded `<style>`. It costs a full
  compile and render per toggle, which for D2 is the slow part.

## Consequences

- **The download grows.** `d2.wasm` is 22 MB (7 MB gzipped) and elk.js another 3.7 MB. A
  document without a D2 fence never loads either; one with a fence does, once per session.
- **The first D2 render is slow.** A small diagram takes about 0.9 s cold. Rendering in a Web
  Worker keeps that off the main thread so typing does not stall; the loading placeholder
  covers the wait.
- **The sanitiser is the only defence on desktop until af-2 ships a CSP.** That is mermaid's
  posture today, with `securityLevel: 'strict'` in place of a sanitiser. D2 has no strict mode,
  so the sanitiser strips external references, `<foreignObject>` and anything executable.
- **D2's own theming is overridden.** `theme-id` in a source does nothing. An author who wants
  a colour writes it on the shape, and it stays.
- **Each D2 SVG carries its fonts** as `@font-face` data URIs, about 35 KB per small diagram.
  The sanitiser keeps those, and only those, `data:` URLs.
- **D2 is not OKF.** To the spec a ` ```d2 ` fence is fenced code; a non-Sunstone reader shows
  its source. The deviation table in [Concept](/okf/concept.md) records it.
- **Another language is now cheap to add**, and adding one is still a decision. PlantUML and
  Graphviz are out of scope until someone asks.
