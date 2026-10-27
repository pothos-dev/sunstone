# Diagram rendering

Add [D2](https://d2lang.com) as Sunstone's second diagram language, next to mermaid.
Mermaid is fine for flowcharts and sequences but weak at architecture diagrams: nested
containers, many-to-many connections and a layout you can steer. D2 was built for exactly
those. A ` ```d2 ` fence should become a **[Diagram](/GLOSSARY.md)** everywhere a
` ```mermaid ` fence does today: `editing` mode, `read` mode, the web viewer and the
print/PDF export.

Three tickets:

- **[dr-1](dr-1-one-block-seam-for-diagram-fences.md)** pulls the language-agnostic half
  out of the mermaid pipeline, so a diagram language is a renderer plus a lazy loader and
  nothing else. Mermaid is the first language on it and does not change.
- **[dr-2](dr-2-sanitiser-for-inline-svg.md)** is a client-side sanitiser for
  author-controlled SVG. D2 needs it, and [af-2](/tickets/attachment-files/af-2-theme-aware-svg-embeds.md)
  reuses it for SVG Embeds.
- **[dr-3](dr-3-d2-fences-render-as-diagrams.md)** registers D2 on dr-1's seam, sends its
  output through dr-2, and themes it with the app palette.
- **[dr-4](dr-4-plantuml-fences-render-as-diagrams.md)** adds PlantUML the same way, from
  `@plantuml/core` ([ADR-0016](/adr/0016-plantuml-renders-in-the-browser-from-its-teavm-build.md)).
  It came after the effort's first scope, on request.

Decisions that bind the whole effort:

- **D2 fences are a Sunstone extension, not OKF.** To the spec a ` ```d2 ` fence is fenced
  code ([§4.2](/okf/spec.md#42-body)), the same as a mermaid one. The row lives in the
  deviation table in [`docs/okf/concept.md`](/okf/concept.md), beside Mermaid's.
- **One block renderer for every diagram language.** Fence detection, the block-replace
  and reveal, double-click to edit, the hover hint, the error state, the render cache and
  the theme rebuild exist once. A language contributes source and theme in, SVG string or
  error out. See [ADR-0014](/adr/0014-diagram-languages-share-one-block-renderer.md), which
  amends [ADR-0005](/adr/0005-mermaid-block-rendering.md).
- **D2 renders client-side from the official WASM build** (`@terrastruct/d2`), lazily, in
  both shells. `sunstone-server` is Rust and D2 is Go, so the web viewer hydrates D2 fences
  as an island, the way `webMermaid.ts` already hydrates mermaid. Nothing renders D2 on the
  server.
- **Every inlined diagram SVG passes dr-2's sanitiser.** Mermaid's `securityLevel: 'strict'`
  is mermaid's own guarantee; D2 has no equivalent, and its output can carry external
  `href`s and `<foreignObject>`. The sanitiser is the guarantee for D2. The desktop CSP stays
  in af-2 and is not a prerequisite here: D2 ships at mermaid's current posture, sanitised
  inline SVG.
- **The app palette wins over the author's theme choice.** D2's `theme-id` and the colours
  of its built-in themes are replaced by the app's CSS custom properties. Explicit colours an
  author wrote on a shape stay as written, the rule af-2 uses for SVG Embeds.

Out of scope for the effort: other diagram languages (Graphviz and the like; dr-1 makes them
possible, and only dr-4's PlantUML was added), D2's interactive features (links, tooltips,
animations, layers, scenarios), a UI toggle for sketch mode, rendering D2 on the server, and
editing aids for D2 such as a grammar, completion or an LSP.
