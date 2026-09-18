# Attachment bytes cross the seam on a custom URI scheme

An **[Attachment](/GLOSSARY.md)** is reached as a **URL**, never as bytes over the IPC
seam. Each shell supplies its own scheme and both confine every resolved path to the
Bundle root with the primitive that already exists:

- **Desktop** registers a custom asynchronous URI scheme handler in Rust —
  `sunstone-asset://` — that resolves each request against the **live** `Session`'s current
  Bundle through `bundle::resolve` (`crates/sunstone-native/src/bundle.rs:216`), which
  rejects absolute and `..`-bearing paths, canonicalizes, and re-checks
  `starts_with(root)`. It needs no `fs:` capability and no `protocol-asset` feature.
- **Web** serves `GET /api/asset` from axum, behind the existing same-origin
  `src/hooks.server.ts` proxy, guarded by `guard_rel_path` at the network boundary and
  `bundle::resolve` at the filesystem.
- **The seam** gains one `Backend` method returning a *URL string* for a bundle-relative
  path, implemented by `tauri.ts`, `http.ts` and `fake.ts`. No `Uint8Array`, `Blob` or
  `ArrayBuffer` crosses it; the `Backend` interface stays entirely JSON-and-string.
- **The shared Rust renderer** takes an asset-URL **prefix** parameter, because one
  `render_concept` feeds two shells: the web viewer (`WebViewer.svelte`) *and* the desktop
  print/PDF window (`PrintView.svelte`). A hardcoded `/api/asset` `src` would 404 in the
  desktop PDF export.

## Considered Options

- **Custom URI scheme + `/api/asset` (chosen)** — the only desktop option whose confinement
  cannot go stale, and the only one that yields a plain URL, so `loading="lazy"` and
  upstream's URL-keyed dimension cache keep working.
- **Tauri's built-in asset protocol** — what the ticket originally proposed. Its scope is
  **static configuration**, but Sunstone's Bundle root is chosen at **runtime**
  (`sunstone ./docs`) and `Session` swaps Bundles while the process lives. The scope can be
  extended at runtime with `allow_directory`, but then every swap must revoke the previous
  grant or a closed Bundle stays readable for the rest of the session — stateful, and silent
  when it is wrong. A per-request resolve against the live Session cannot have that bug.
- **Bytes over IPC** — fits the existing command surface, but it forces `createObjectURL`
  lifetime management into the widget, breaks `loading="lazy"`, and defeats the dimension
  cache that keeps a decoding image from growing the heightmap mid-scroll.
- **`tower-http`'s `ServeDir` for the web route** — a new dependency and a second notion of
  where the Bundle root is, when `state.app.bundle_root` and one hand-written handler reuse
  the authority every other route already shares.
- **A marker `src` rewritten client-side**, mirroring the renderer's existing
  `sapint:`/`sapbroken:`/`sapext:` link markers — rejected because SSR output would then
  carry broken images until hydration, and the print window would need a hydration pass
  before `window.print()` fires.

## Consequences

- **Confinement is implemented once.** `bundle::resolve` is already symlink-escape tested
  (`bundle.rs:351`, `:386`); the asset paths add cases to a tested primitive rather than a
  second implementation to keep in step.
- **Remote (`http`/`https`) Embeds are never fetched automatically** and `data:` URIs are
  not rendered at all. A remote Embed shows a neutral click-to-load affordance, so opening a
  Concept cannot fire a tracking pixel from the reader's browser and IP — which on the web
  shell is a different person from the author.
- **`app.security.csp` stays `null` for now.** Adding a Content-Security-Policy is a
  whole-app change with its own breakage surface (mermaid's injected SVG, `{@html}`, Vite's
  dev inline scripts) and belongs with
  [ei-2](/tickets/embedded-images/ei-2-theme-aware-svg-embeds.md), whose
  inlined author-controlled SVG is the first thing that genuinely needs it.
- **Attachments are as readable as the Concepts that embed them.** `GET /api/asset` is
  unauthenticated, exactly like `/api/concept` and `/api/render`; only `/api/history` and
  `/api/file-at-rev` are gated. This is a deliberate match, not an oversight.
- The renderer's prefix parameter is the seam that keeps SSR, the web viewer and the desktop
  PDF on one HTML pipeline; a future third shell supplies a third prefix and nothing else.
