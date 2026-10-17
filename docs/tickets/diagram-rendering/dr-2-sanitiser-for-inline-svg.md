---
status: done
priority: 3
---

# dr-2: A sanitiser for author-controlled inline SVG

**What to build:** a client-side module that takes an SVG string and returns a safe one, ready
to insert into the app document. Anything that could run script, load from the network or
reach outside its own SVG is removed. Everything a diagram needs to draw itself, including a
`<style>` block, stays.

Two features need this. [dr-3](dr-3-d2-fences-render-as-diagrams.md) inlines D2's output, which
is author-controlled: a D2 source can produce external `href="https://..."` on icons and links,
and `<foreignObject>` for markdown labels (`|md ...|`). We have not seen D2 emit `<script>`, but
we do not trust that. [af-2](/tickets/attachment-files/af-2-theme-aware-svg-embeds.md) inlines
embedded `.svg` files, which are author-controlled by definition. One sanitiser serves both, so
its rejections are written and tested once.

Build it on **DOMPurify** with its SVG profile. Writing an SVG sanitiser by hand is how XSS
bugs get written, and DOMPurify has years of bypass reports behind it. Mermaid already depends
on it, so it is in `node_modules` today, but only transitively; add it as a direct dependency
so the version is ours to pin.

The sanitiser strips:

- `<script>`, every `on*` attribute, and `<iframe>`, `<embed>`, `<object>`
- `<foreignObject>` and everything inside it
- `javascript:` and `data:` URLs in any attribute
- `href` and `xlink:href` that do not start with `#`, so only same-document references survive
- `<use>` that points outside the document
- `url(...)` in a `style` attribute that is not a `#fragment`
- inside `<style>`: every `@import`, and every `url(...)` that is external or a `data:` URL,
  with one exception, `data:` fonts inside `@font-face`

That exception exists for D2, which embeds its three fonts as `@font-face` data URIs (about
35 KB per small diagram). Stripping them would fall back to the app font and change the
diagram's metrics.

- [x] `sanitiseSvg(svg: string): string` (or a DOM-returning sibling, if the callers prefer it)
      in a plain `.ts` module, with no dependency on CodeMirror or Svelte
- [x] `dompurify` is a direct dependency in `package.json`
- [x] Each stripped construct above has a unit test with a hostile fixture that asserts it is
      gone from the output
- [x] A test asserts `<style>` survives with its ordinary rules and its `@font-face` data
      fonts, minus any `@import` and external `url()`
- [x] A test asserts `#fragment` references (gradients, markers, `<use href="#id">`) survive
- [x] A real D2 output (checked in as a fixture) passes through visually unchanged apart from
      stripped external icons
- [x] Tests run under `bun test src/lib`; DOMPurify needs a DOM, so the test supplies one the
      same way other DOM-touching unit tests in `src/lib` do, or the ticket adds the smallest
      one that works
- [x] All four gates green

## Decisions

- **Client-side only.** The web viewer renders diagrams client-side, so the sanitiser runs in
  the browser. af-2 also sanitises SVG on the server path for its SSR output; that Rust-side
  sanitiser stays in af-2.
- **The desktop CSP stays in af-2.** A CSP is the layer that makes a sanitiser bug survivable,
  and af-2 already owns it. This ticket ships the sanitiser alone.
- **Ids are not namespaced here.** Per-diagram id uniqueness is the caller's job: D2 has
  `salt`, mermaid generates its own ids, and af-2 specifies its own namespacing.

## Comments

- Done. `sanitiseSvg(svg, win?)` is in `src/lib/svg/sanitiseSvg.ts`, and the CSS half
  (`<style>` text and `style` attributes) is in `src/lib/svg/sanitiseCss.ts`. When there is
  no window, or DOMPurify reports itself unsupported, it throws instead of passing the input
  through. Beyond the listed constructs it also drops SMIL animation (`<set>`/`<animate*>`
  can rewrite an href after sanitising), the image functions that take a bare string as a URL
  (`image-set()`, `image()`, `cross-fade()`, `element()`), and any `<use>`/`<image>`/`<feImage>`
  left without a local href. CSS with a backslash escape, or with a `url(` it cannot parse,
  is emptied instead of guessed at. The tests pass in a jsdom window explicitly (jsdom is a
  devDependency). I tried happy-dom first: DOMPurify kept `onerror` under it. The D2 fixture
  (`src/lib/svg/fixtures/d2-diagram.svg`) comes out identical element for element and
  attribute for attribute, except for the icon `<image>` and the link's hrefs.
