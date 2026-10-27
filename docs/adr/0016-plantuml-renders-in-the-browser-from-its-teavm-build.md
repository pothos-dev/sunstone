# PlantUML renders in the browser from its TeaVM build, on the main thread

PlantUML is the third language on the diagram seam of [ADR-0014](0014-diagram-languages-share-one-block-renderer.md).
A ` ```plantuml ` fence renders client-side, in both shells, from `@plantuml/core`:
PlantUML's own build, compiled from Java to JavaScript with TeaVM, with Graphviz from
viz.js's WASM build. It loads only when a document holds a ` ```plantuml ` fence. It runs
on the main thread, its SVG passes the shared sanitiser, and it is themed at render time
by a PlantUML `<style>` block with concrete colours from the app palette, as mermaid is.

## Considered Options

- **`@plantuml/core` in the browser (chosen).** MIT from 1.2026.6, published by the PlantUML
  project, no server and no JVM. The same code runs on desktop, in `sunstone serve` and in the
  anonymous web reader, which is what ADR-0014 asked of D2.
- **Shell out to `plantuml.jar` from Rust.** Rejected for D2's reason: a JVM on every install,
  and the web reader has no Rust side to call.
- **Kroki or the plantuml.com server.** Rejected: a Concept's diagram source would leave the
  machine, and rendering would fail offline.
- **The CheerpJ build of the jar.** Rejected: it runs the real JVM in the browser, heavier than
  TeaVM for no gain.
- **A Web Worker, as D2 (rejected).** The engine needs a DOM: it builds the SVG with
  `createElementNS` and measures text with canvas `measureText` and `getBBox`. A worker with an
  `OffscreenCanvas` shim failed at the first `createElementNS`; a full DOM shim would have to
  track the engine's internals from release to release.
- **Theme via a `<style>` preamble (chosen).** PlantUML writes literal colours on elements and
  has no classes to restyle, so D2's stylesheet approach does not apply. The preamble goes
  right after the `@start…` line, so the author's own `skinparam`, `!theme` or `#colour` comes
  later and wins.

## Consequences

- **The download grows**, by `plantuml.js` (7.2 MB, 1.4 MB gzipped) and `viz-global.js`
  (1.4 MB), plus the 1.9 MB emoji table only for a source with an emoji. A document without a
  PlantUML fence loads none of it.
- **The first render blocks the main thread** for the ~0.4 s it takes to parse the engine, then
  15–300 ms per diagram. Diagrams render when a Concept opens and when the caret leaves a fence,
  not per keystroke.
- **A theme flip re-renders** every PlantUML diagram, as for mermaid.
- **The engine's script loader is disabled.** It would append page-relative `<script src>` tags
  for icons, emoji and the standard library. Icons and emoji come from tables bundled with the
  app; `!include <…>` of the standard library and remote includes fail.
- **PlantUML is not OKF.** To the spec a ` ```plantuml ` fence is fenced code. The deviation
  table in [Concept](/okf/concept.md) records it.
