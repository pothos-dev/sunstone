---
status: review
priority: 3
blocked-by: [dr-1, dr-2]
---

# dr-3: ```d2 fences render as diagrams in the app palette

**What to build:** a ` ```d2 ` fence renders as a **[Diagram](/GLOSSARY.md)** in `editing`
mode, `read` mode, the web viewer and the print/PDF export, coloured with the app palette so
it reads as part of the app in light and dark. D2 is the second language registered on
[dr-1](dr-1-one-block-seam-for-diagram-fences.md)'s seam, so the reveal, double-click to edit,
the error panel, caching and the theme rebuild all come from there.

The renderer is the official WASM build, `@terrastruct/d2` (0.1.33, D2 v0.7):
`new D2()`, then `d2.compile(src, { layout })` returns `{ diagram, renderOptions }`, then
`d2.render(diagram, { ...renderOptions, noXMLTag: true, salt, pad })` returns the SVG string.
It is heavy: `d2.wasm` is 22 MB (7 MB gzipped) plus 3.7 MB of elk.js, and a small diagram takes
about 0.9 s to compile and render cold in Node. That cost decides most of the criteria below.

**Theming.** D2 colours themed elements by class (`fill-N1`, `stroke-B1`, `fill-B6`, ...; slots
N1 to N7, B1 to B6, AA2, AA4, AA5, AB4, AB5) and defines those classes in a `<style>` block
inside the SVG, scoped by a per-diagram class, e.g. `.d2-2922646921 .fill-B6{fill:#F7F8FE;}`.
Colours an author writes (`style.fill: "#FF0000"`) are emitted as literal attribute values,
not classes. So a scoped stylesheet of ours that maps each slot class to an app CSS custom
property recolours every themed element, leaves authored colours alone, and follows a theme
toggle with no re-render. That only works if our rules beat D2's embedded ones; D2's selector
is two classes deep, so ours has to be more specific. Verify that first. If it cannot be made
to win reliably, fall back to prepending
`vars: { d2-config: { theme-overrides: { N1: "#..."; ... } } }` with the resolved colours to
the source (verified to work) and let dr-1's theme-keyed cache and rebuild do the rest, as
mermaid does.

- [x] D2 is registered on dr-1's seam with the `d2` info string, and renders in `editing`,
      `read`, the web viewer island and print/PDF
- [x] `@terrastruct/d2` is loaded with a dynamic `import()` only when a document holds a
      ` ```d2 ` fence; it is never in the initial bundle of either shell (check the build
      output)
- [x] Rendering runs in a Web Worker through `@terrastruct/d2/worker` if it works in both
      shells' builds, so the cold start does not block typing; if it does not, the ticket
      says why in a comment
- [x] Every D2 SVG goes through [dr-2](dr-2-sanitiser-for-inline-svg.md)'s sanitiser before
      insertion
- [x] Each block renders with its own `salt`, and a test with two D2 diagrams in one Concept
      shows no id collision (markers and gradients still point at their own diagram)
- [x] Themed elements take the app palette in both themes, through scoped CSS overrides of
      D2's slot classes, and a theme toggle recolours them without a re-render; or, if the
      overrides cannot win over D2's `<style>`, through prepended `theme-overrides` with the
      theme in the cache key
- [x] A shape with an explicit author colour renders in that colour in both themes
- [x] A `theme-id` in the D2 source has no effect on the rendered palette
- [x] Rendering fetches nothing from the network: external icon references are stripped, and
      a Playwright test asserts no request leaves for an `icon:` URL
- [x] A compile error shows in the same error panel mermaid uses, with D2's message
- [x] The slot-to-CSS-variable mapping is a pure module with unit tests, in the manner of
      `mermaidTheme.ts`
- [x] Print/PDF renders D2 in the light palette, as `PrintView.svelte` forces for mermaid
- [x] The native render leaves a ` ```d2 ` fence as an inert `<pre><code class="language-d2">`,
      asserted next to `mermaid_fence_emits_language_class_and_is_left_inert`
      (`crates/sunstone-native/src/render/mod.rs`)
- [x] Playwright coverage in the desktop suite, following `tests/mermaid-*.spec.ts` (render,
      edit affordance, error state, theme sync), and in the web e2e suite, following the
      mermaid cases in `tests/web-viewer.spec.ts`
- [x] All four gates green

## Decisions

- **No CSP in this ticket.** The desktop CSP is af-2's. D2 ships at mermaid's current posture,
  sanitised inline SVG, and af-2 later hardens both.
- **Layout engine.** Default to `dagre`, which needs no elk.js. A source that sets
  `layout-engine: elk` in `vars` gets elk, loaded on demand only for that diagram.
- **Sketch mode is honoured if the source asks for it** (`sketch: true` in `vars`), since that
  costs nothing. A UI toggle for it is out of scope.
- **Interactive features are inert.** D2 links, tooltips, animations, layers and scenarios are
  out of scope for the effort; whatever D2 emits for them is either stripped by dr-2 or drawn
  as static shapes.

## Comments

- Built; needs a human's eyes on the look, on a real machine, in both themes. Modules:
  `editor/d2Language.ts` (seam entry, sanitised with `sanitiseSvg`), `d2Worker.ts` (the Web
  Worker), `d2Engine.ts` (pure: forced render options, error cleanup, call queue), `d2Theme.ts`
  (pure: slot class → app CSS variable, one stylesheet). The seam gained one optional flag,
  `themedByStylesheet`: a D2 SVG does not depend on the theme, so both themes share one cache
  entry and a theme flip repaints from the cache. No re-render.
- **Worker, not `@terrastruct/d2/worker`.** That export points at `dist/browser/worker.js`,
  and the package doesn't ship that file. The browser build already runs the Go runtime in a
  worker of its own, but it decodes the inline `d2.wasm` (brotli, base64, ~0.7 s) on the
  thread that calls `new D2()`. So `D2` is constructed inside our own module worker, with
  `window` aliased so the library takes its browser path. That needs nested dedicated
  workers, which I checked by hand in WebKitGTK 2.54 (python-gi under broadway), over
  http and over a custom `tauri://` scheme: ready in ~1.2 s, a small render in ~0.15 s
  after that. Chromium is covered by Playwright. I did not test macOS WKWebView or Windows
  WebView2.
- **Lazy load.** The engine is a separate 8.2 MB chunk
  (`_app/immutable/workers/d2Worker-*.js`) in both the desktop and the web build. It is
  fetched by `new Worker(new URL(...))` the first time a `d2` fence renders. It is not
  among `index.html`'s modulepreloads, the web SSR output has no reference to it, and a
  Playwright test asserts that a Concept without a D2 fence never requests it. It is not a
  dynamic `import()`, but the effect is the same.
- **elk.js deviates from the Decisions.** The browser build bundles elk.js into its inner
  worker and evaluates it when that worker starts, so elk is not loaded "only for that
  diagram". Dagre is still the default; `layout-engine: elk` in `vars` switches a diagram
  to elk.
- **Print.** The on-screen print sheet now declares the same light tokens `@media print`
  forces (plus `--text-faint`/`--border-strong`). Before, the sheet inherited dark tokens
  in a dark app. This also affects mermaid and code wells in the preview.
- **Please look at:** the palette in `/tmp/d2-light.png` and `/tmp/d2-dark.png` (desktop
  suite; a real app is better). In particular: (1) shape borders use `--text` at D2's 2 px,
  heavier than mermaid's 1 px nodes; (2) in dark, a container's `--bg-sunken` fill is only
  slightly darker than the page, so its outline (`--border-strong`) carries it;
  (3) cylinders use an accent tint, queues `--border`, diamonds `--border-strong`;
  (4) a stripped icon leaves its reserved space empty (the label sits at the top of a tall
  box); (5) the first D2 render in a session takes ~1–2 s behind the "Rendering diagram…"
  placeholder. Also open a D2 Concept once in the real Tauri app on Linux and macOS.
- Known: two blocks with byte-identical D2 source share a cached SVG, so their ids match.
  The content is identical too, so the references still resolve. D2's unscoped `<style>`
  rules (`.shape`, `.connection`, `.blend`, …) apply document-wide; nothing in the app uses
  those class names.
