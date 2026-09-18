---
status: ready-for-agent
priority: 3
---

# ei-1: Embedded images in a Concept

**What to build:** an image file stored in the Bundle — an **[Attachment](/GLOSSARY.md)** — renders inline in the Concept that **Embeds** it, in `editing` mode, `read` mode, the server-rendered web view and the print/PDF export. Both Embed forms work: `![alt](path.png)` resolves **by path** through `resolveLink`; `![[name.png]]` resolves **by name** under the [ADR-0004](/adr/0004-wikilinks-optional-secondary-name-based.md) rules — case-insensitive, literal, partial paths by suffix, duplicates taking the shortest Bundle path.

Recognised extensions: `png`, `jpg`/`jpeg`, `gif`, `webp`, `avif`, `bmp`, `svg`, case-insensitively.

**This is a Sunstone extension, not OKF.** The spec says nothing about images, media or attachments; §3 calls a Bundle "a directory tree of markdown files" and §3.1 makes every non-reserved `.md` a Concept, which leaves non-`.md` files *unspecified* rather than forbidden. Obsidian is the reference behaviour, for the reason ADR-0004 gives.

Two ADRs written for this ticket carry the design and **must be read first**: [ADR-0010](/adr/0010-embeds-as-point-widgets-over-inline-preview.md) (how an Embed renders) and [ADR-0011](/adr/0011-attachment-bytes-cross-a-custom-uri-scheme.md) (how the bytes reach the frontend).

## Grounding

Correcting the original framing — two of its premises are wrong:

- **`![alt](path.png)` already renders.** atomic-editor's `imageBlocks()` is wired at `src/lib/editor/extensions.ts:224` and emits a real `<img>` block widget below the source line, and `inlinePreview` already hides the whole `Image` node on inactive lines (`inline-preview.js:553-572`). The image does not fail to *render*; it fails to *load*, because `src` is a bundle-relative path the webview cannot fetch. The `!`-dropping in `src/lib/ipc/fake/links.ts:96-100` and `crates/sunstone-native/src/index/links.rs:37-46` keeps images out of the **index**, which is correct and mostly stays.
- **There is no `hybrid` or `edit` mode.** `EditorMode` is `'editing' | 'read'` (`src/lib/editor/extensions.ts:170`); the three-way collapsed, with a migration in `src/lib/state/layoutPersist.ts:33`. There is no source-only mode.

What already exists and should be reused rather than rebuilt:

- `bundle::resolve` (`crates/sunstone-native/src/bundle.rs:216`) — absolute-reject, component-reject, `canonicalize()`, `starts_with(root)`, symlink-escape tested at `bundle.rs:351` and `:386`. This is the confinement primitive; do not write a second one.
- `guard_rel_path` (`crates/sunstone-server/src/routes_read.rs:162`) — the cheap network-boundary pre-check.
- `resolve_wikilink` (`crates/sunstone-shared/src/wikilink.rs:138`) — the name-resolution rules, compiled to native **and** wasm, so the fake backend shares them.
- Upstream `imageBlocks`' `dimensionCache` trick (`node_modules/@atomic-editor/editor/dist/image-blocks.js`) — pins `width`/`height` on remount so a decoding image cannot grow the heightmap under an in-flight scroll.

Where nothing exists yet: no `Backend` method returns bytes or an asset URL; `tauri.conf.json` has no `assetProtocol` block and `protocol-asset` is not a Cargo feature; `sunstone-server` has no static-file middleware; and `crates/sunstone-native/src/render/mod.rs` never touches `NodeValue::Image`, so comrak emits the author's raw relative `src`.

## Acceptance criteria

- [ ] `![alt](path.png)` renders in `editing`, `read`, the web view and the print/PDF export, for relative and bundle-absolute paths
- [ ] `![[name.png]]` renders under the ADR-0004 name-resolution rules, including partial paths and the shortest-path tie-break
- [ ] An Embed alone on its line renders as a block widget below it; an Embed among text renders inline, in flow, and is suppressed while its own line is active
- [ ] `![[img.png|300]]`, `![[img.png|300x200]]`, `![300](img.png)` and `![300x200](img.png)` all size the image; in an Embed the `|` suffix is never an alias
- [ ] One new `Backend` method returns an Attachment URL and is implemented by `tauri.ts`, `http.ts` and `fake.ts`; no bytes cross the seam
- [ ] Desktop serves Attachments over a custom URI scheme resolved per request against the live `Session`
- [ ] `GET /api/asset` refuses any path escaping the Bundle root — `..` traversal, absolute paths, symlink escape — with a test per case
- [ ] `render_concept` takes an asset-URL mapper (`&dyn Fn(&str) -> String`; a prefix cannot express both shells' URL shapes) and rewrites every Embed `src`, so the web view and the desktop PDF both show images
- [ ] An unresolvable Embed shows an error placeholder styled like `cm-broken-link` (and `data-broken="true"` in the SSR render) and never breaks the rest of the Concept
- [ ] A remote (`http`/`https`) Embed shows a neutral click-to-load affordance and fetches nothing until clicked; a `data:` URI does not render
- [ ] In `read` mode, clicking an image the content column has downscaled opens a lightbox; in `editing`, clicking still places the caret on the source line
- [ ] Attachments stay out of the Explorer tree and out of Backlinks; moving a Concept rewrites its relative Embed paths
- [ ] `docs/okf/bundle.md` records Attachments and Embeds in its deviation table; `docs/okf/linking.md` drops embeds from its out-of-scope list
- [ ] Unit tests cover Embed detection, size parsing, placement choice and both resolution models; Playwright covers a rendered Embed in both suites
- [ ] All four gates green

## Decisions

Settled in a grilling session; the reasoning that needed more than a line went into ADR-0010 and ADR-0011.

- **Domain language** → the file is an **Attachment**, the reference is an **Embed**. Both are now in `docs/GLOSSARY.md`. "Attachment" is chosen over "asset" so the term still fits when non-image files arrive.
- **Rendering model** → a point widget layered over `inlinePreview`, block when alone on a line and inline otherwise, deliberately diverging from ADR-0005's block-replace. See [ADR-0010](/adr/0010-embeds-as-point-widgets-over-inline-preview.md). Upstream `imageBlocks()` comes out of `extensions.ts` so nothing double-renders.
- **Transport** → a custom URI scheme on desktop, `/api/asset` on web, a URL (never bytes) across the seam, and an asset-URL **mapper** (`&dyn Fn(&str) -> String`) on the shared renderer. See [ADR-0011](/adr/0011-attachment-bytes-cross-a-custom-uri-scheme.md).
- **Remote images** → click-to-load, never automatic. Opening a Concept must not fire a tracking pixel from a reader's browser. `data:` URIs do not render at all: they are an injection vector once [ei-2](ei-2-theme-aware-svg-embeds.md) inlines SVG, and they carry no benefit a Bundle file does not.
- **Size suffix in the markdown form too** (`![300](x.png)`) → adopted. "Match Obsidian exactly" is ADR-0004's governing rule and this is the same compatibility class. The false positive is narrow — alt text that is purely digits or `NxN` — and its failure mode is a mis-sized image, not a broken one.
- **Sizing semantics** → upscale when the requested width exceeds the natural width (Obsidian's behaviour); keep `max-width: 100%`, so a size is a request the content column may clamp. An explicit size is applied as CSS `width`/`height`, **not** as HTML attributes, so it cannot corrupt the URL-keyed `dimensionCache`, which keeps storing *natural* dimensions.
- **Accessible name** → the filename with extension, for `![[x.png]]` and for a markdown Embed whose alt was consumed as a size. `alt=""` would be a lie: an embedded diagram is content, not decoration.
- **Placeholders** → two visuals, not three. An error placeholder (`var(--danger)`, dashed, matching `cm-broken-link`) covers both an unresolvable path and a resolved path whose bytes fail to load — the latter needs an `onerror` handler upstream does not have. The neutral click-to-load affordance is for remote Embeds only, which are a normal state and not an error.
- **Click gesture** → `editing` keeps upstream's caret-to-source, the only way to reach a source line `inlinePreview` has hidden. `read` has no caret to place, so the gesture buys a lightbox for downscaled images.
- **Attachment index** → a **separate** index from `all_paths`, not a type-tagged single index. The original justification here was overclaimed and is corrected: `find_bundle_root` (`crates/sunstone-shared/src/links.rs:161`) already filters its input to `.md`, so Attachments could not have shifted the inferred root. The real reason is breadth — `concept_paths()` also feeds the Explorer tree, Quick nav, the Wikilink candidate set and the wasm `BundleIndex`, and every one of those must stay `.md`-only. A separate index makes that hold by construction across all five consumers rather than by five remembered filters.
- **Rewrite asymmetry** → only the **markdown** rewrite path gains `!` handling. Extraction keeps dropping `!` (no Backlinks edge), and `sunstone-shared`'s wikilink scanner is untouched: `![[name.png]]` and `![[folder/name.png]]` resolve bundle-wide by name and suffix, so moving a Concept can never invalidate them. That asymmetry is deliberate and needs a comment at both sites, or someone will "fix" it back — the shared-scanner invariant in `wikilink.rs` survives intact.
- **Non-image Embeds** → out of scope; they keep today's literal rendering until [al-1](/tickets/attachment-listing/al-1-non-image-attachments-listed-on-a-concept.md).
- **CSP** → out of scope here, and an explicit AC on [ei-2](ei-2-theme-aware-svg-embeds.md) rather than a fourth ticket. ei-2's inlined author-controlled SVG is the first thing that genuinely needs one.
