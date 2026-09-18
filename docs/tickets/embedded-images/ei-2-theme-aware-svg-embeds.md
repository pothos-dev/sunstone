---
status: ready-for-agent
blocked-by: [ei-1]
---

# ei-2: Embedded SVGs inherit the editor's colour scheme

**What to build:** an embedded `.svg` that leaves its colours unspecified picks up the app palette, so a diagram authored as black strokes on transparent is legible in dark mode instead of vanishing into the background. This is the same goal [ADR-0005](/adr/0005-mermaid-block-rendering.md) already met for Diagrams, where `mermaidTheme.ts` resolves the app's CSS custom properties to concrete values and hands them to mermaid so a Diagram reads as part of the app in both themes.

The mechanism forces the design. An `<img src="x.svg">` is an **isolated document** — page CSS, CSS custom properties and `currentColor` never cross into it, so the `<img>` path can never inherit anything. Only inlining the SVG markup into the app document makes inheritance possible. So an embedded SVG takes a different path from a raster embed: its bytes are fetched through the same `Backend` seam added in [ei-1](ei-1-embedded-images-in-concepts.md), then inserted as live DOM.

The colour rule must be conservative, because recolouring is only wanted where the author left the decision open. A `fill` or `stroke` that is absent, `inherit`, or `currentColor` resolves to `--text`; every explicitly-coloured element is left exactly as authored. A logo with brand colours must survive a theme switch untouched — the feature is for line art and exported diagrams, not a global invert. Where nothing is inherited the result is identical to the raster path, so the fallback is the current behaviour rather than a broken one.

**The risk this ticket carries is injection.** Inlining an SVG puts author-controlled markup into the app document, where `<script>`, event-handler attributes, `foreignObject` and external references all execute with the app's privileges — and in the web shell they also reach the SSR output, where the Concept's author and the reader may be different people. The markup must be sanitised to a known-safe subset before insertion, on both the desktop and the server path, and the sanitiser's rejections must be tested directly rather than assumed. `id` collisions between two inlined SVGs in one Concept are the smaller sibling of the same problem: ids are document-global, so they need namespacing per embed.

Theme changes re-render, following mermaid's theme-sync: the resolved `'light' | 'dark'` is part of any cache key, since the colours are resolved into the DOM at insert time and a stale cached tree would keep the old palette after a toggle.

- [ ] An embedded SVG with unspecified, `inherit` or `currentColor` fills and strokes renders in `--text` and re-colours on a theme switch
- [ ] An SVG with explicit colours renders exactly as authored in both themes
- [ ] SVG markup is sanitised before insertion — scripts, event handlers, `foreignObject` and external references are stripped — on the desktop path and in the server render
- [ ] Sanitiser tests assert each rejected construct, using hostile SVG fixtures
- [ ] Ids inside an inlined SVG are namespaced per embed, so two SVGs in one Concept do not collide
- [ ] The colour-resolution logic is a pure module unit-tested without a DOM, in the manner of `mermaidTheme.ts`
- [ ] The rendered result is keyed on source plus resolved theme, so a toggle never leaves a stale palette
- [ ] Sizing from [ei-1](ei-1-embedded-images-in-concepts.md) (`![[d.svg|300]]`) applies to inlined SVGs too
- [ ] All four gates green
