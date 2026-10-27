---
status: review
priority: 2
blocked-by: [dr-1, dr-2]
---

# dr-4: ```plantuml fences render as diagrams in the app palette

**What to build:** a ` ```plantuml ` fence renders as a **[Diagram](/GLOSSARY.md)** in
`editing` mode, `read` mode, the web viewer and the print/PDF export, in the app palette,
as the third language on [dr-1](dr-1-one-block-seam-for-diagram-fences.md)'s seam. The
engine is `@plantuml/core` (1.2026.6, MIT): PlantUML compiled from Java to JavaScript with
TeaVM, plus Graphviz from viz.js. See [ADR-0016](/adr/0016-plantuml-renders-in-the-browser-from-its-teavm-build.md).

- [x] PlantUML is registered on dr-1's seam with the `plantuml` info string, and renders in
      `editing`, `read`, the web viewer island and print/PDF
- [x] The engine (`plantuml.js` + `viz-global.js`, ~8.6 MB) loads with a dynamic `import()`
      only when a document holds a ` ```plantuml ` fence; it is not in either shell's initial
      bundle
- [x] A fence without `@startuml` is wrapped in `@startuml`/`@enduml`, as GitHub and GitLab do
- [x] Every PlantUML SVG goes through [dr-2](dr-2-sanitiser-for-inline-svg.md)'s sanitiser
- [x] Themed elements take the app palette in both themes (a `<style>` preamble with concrete
      colours, the theme in the cache key, as mermaid); colours an author writes stay
- [x] A syntax error shows in the shared error panel with PlantUML's message and its line in
      the fence, not a picture of the error
- [x] Nothing loads a script or reaches the network: `<&icon>` and `<:emoji:>` come from
      tables bundled with the app, `!include <stdlib>` and remote includes fail, links and
      remote images are stripped
- [x] The palette mapping and the source/error handling are pure modules with unit tests
- [x] The native render leaves a ` ```plantuml ` fence as an inert
      `<pre><code class="language-plantuml">`
- [x] Playwright coverage in the desktop suite (`tests/plantuml-diagrams.spec.ts`) and the
      web e2e suite (`tests/web-viewer.spec.ts`, render, theme toggle, error, print)
- [x] All four gates green

## Decisions

- **Main thread, not a Web Worker.** The engine builds its SVG with `createElementNS` and
  measures text on a canvas and with `getBBox`. A worker with an `OffscreenCanvas` shim got
  as far as the first `createElementNS` and failed. Parsing the engine costs ~0.4 s once per
  session; a small diagram then renders in 15–300 ms. Renders run one at a time
  (`serialQueue.ts`, shared with D2), because the engine keeps one shared render slot.
- **The script loader is switched off.** For icons, emoji and `!include <…>` the engine
  appends `<script src>` with a page-relative path (`openiconic.js`, `c4.min.js`), which
  would run whatever our origin serves there. `window.__pl_script_state` is replaced with a
  table that reports every script as loaded. The icon table (51 KB) loads with the engine,
  the emoji table (1.9 MB) only for a source that uses one.
- **The standard library is not shipped.** `@plantuml/core` does not include it, and
  `!include <C4/…>` fails with PlantUML's "cannot include".
- **`dominant-baseline` is allowed by the shared sanitiser.** DOMPurify's list lacks it, and
  PlantUML centres a class's stereotype letter with it. It takes only keywords.
- **The diagram root resets inherited font properties.** SVG text inherited the editor's
  weight 500 while PlantUML measured at 400, which pushed labels past their boxes.
- **Only `plantuml` as info string**, not `puml`: it is what GitHub and GitLab render.

## Comments

- Built; needs a human's eyes on two things no test here covers.
  (1) **The look**, in both themes: `tests/screenshots/plantuml-light.png` and
  `plantuml-dark.png` from the desktop suite. Start circles are drawn hollow (surface
  fill) rather than solid, fork bars in activity diagrams are faint in dark, and the
  class stereotype circles lose PlantUML's green/purple tints for the surface colour.
  (2) **The real Tauri app** on Linux (WebKitGTK) and macOS: only Chromium ran it. The engine
  uses canvas `measureText` and `getBBox`, both standard, but the ~0.4 s parse on the main
  thread is worth feeling once on a slow machine.
- The engine logs a dozen `console.log` lines per render (`[PSystemBuilder2] …`). Harmless,
  noisy in devtools; there is no switch for it.
