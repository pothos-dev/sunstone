---
status: ready-for-agent
---

# ei-1: Embedded images in a Concept

**What to build:** an image file stored in the Bundle renders inline in the Concept that embeds it, in reading mode, hybrid mode and the server-rendered web view. Today neither form renders: markdown images are skipped by link extraction on purpose (`src/lib/ipc/fake/links.ts` and the Rust `index/links.rs` both drop a `[text](…)` match preceded by `!` as "not a Concept link"), and `![[ … ]]` embeds are deferred by [ADR-0004](/adr/0004-wikilinks-optional-secondary-name-based.md), so the scanner sees a literal `!` plus a wikilink. Both forms currently show as raw text everywhere.

**OKF says nothing about embeds.** The spec has no mention of images, media, binaries or attachments; §3 describes a Bundle as "a directory tree of markdown files" and §3.1 says every non-reserved `.md` file is a Concept, which leaves non-`.md` files *unspecified* rather than forbidden. So image support is a Sunstone extension and must be recorded as such in [`docs/okf/bundle.md`](/okf/bundle.md) alongside the other deviations. The behaviour to copy is Obsidian's, for the same reason ADR-0004 gives: the Bundles that carry embeds came from Obsidian vaults, so matching it exactly is what makes existing content render as its author intended.

The two syntaxes resolve through the two models Sunstone already has. `![alt](path.png)` resolves **by path** through `resolveLink` — relative and bundle-absolute, exactly like a markdown link. `![[name.png]]` resolves **by name** under the ADR-0004 rules: case-insensitive, literal, partial paths match by suffix, duplicates take the shortest Bundle path. One deliberate divergence from the wikilink grammar: in an embed the `|` suffix is a **size**, not an alias — `![[img.png|300]]` is a width and `![[img.png|300x200]]` is width×height. Recognised extensions: `png`, `jpg`/`jpeg`, `gif`, `webp`, `avif`, `bmp`, `svg`.

Most of the work is at the seam, because the frontend cannot reach the filesystem. On desktop the image lives outside the webview origin, so `src/lib/ipc/tauri.ts` must produce a loadable URL — Tauri's asset protocol with its scope confined to the Bundle root, or bytes over IPC — exposed as one new `Backend` method that `fake.ts` and `http.ts` also implement; no `@tauri-apps/api` import escapes `src/lib/ipc/`. On web, `sunstone-server` gains a route that serves bundle-relative asset bytes with the resolved path confined to the Bundle root (no `..` traversal, no symlink escape), and the Rust render that builds `RenderPayload` rewrites each image `src` to it so SSR output and the print/PDF path are correct too.

In the editor an image renders the way a Diagram does under [ADR-0005](/adr/0005-mermaid-block-rendering.md): a widget in reading and hybrid mode, with the raw source revealed under the cursor in hybrid and left as plain text in source `edit` mode. Take the render-cache lesson with it — decoration identity must stay stable across unrelated document changes so an image is not torn down and re-decoded on every keystroke, and a loaded image must not reflow the document under the caret.

A missing target is tolerated, never fatal: OKF §5.3's broken-link rule applies to embeds too, so an unresolvable image shows a visible placeholder in the same spirit as `cm-broken-link` and the Concept keeps rendering. Image files remain outside `md_files` and the tree — they are not Concepts — and embeds do **not** feed Backlinks, since an image is not a Concept-to-Concept relationship. Moving a Concept must still keep its relative embed paths pointing at the same file, which is the outbound-relative case the rewrite engine already handles and currently skips for `!`-prefixed links.

- [ ] `![alt](path.png)` renders inline in reading mode, hybrid mode and the web view, for relative and bundle-absolute paths
- [ ] `![[name.png]]` renders inline under the ADR-0004 name-resolution rules, including partial paths and the shortest-path tie-break
- [ ] `![[img.png|300]]` and `![[img.png|300x200]]` size the image; the suffix is never treated as an alias
- [ ] In hybrid mode the raw embed source is revealed under the cursor and re-renders when the cursor leaves; `edit` mode shows source only
- [ ] One new `Backend` method serves image URLs and is implemented by `tauri.ts`, `http.ts` and `fake.ts`
- [ ] The web asset route refuses any path that escapes the Bundle root, including `..` traversal and symlinks, with a test per case
- [ ] The server-side render rewrites image `src`, so SSR and the print/PDF path show the same images as the editor
- [ ] An unresolvable embed shows a visible placeholder and never breaks the rest of the Concept
- [ ] Image files stay out of the tree and out of Backlinks; moving a Concept keeps its relative embed paths valid
- [ ] `docs/okf/bundle.md` records embeds as a documented Sunstone extension over the OKF spec, and `docs/okf/linking.md` drops embeds from its out-of-scope list
- [ ] Unit tests cover embed parsing, size parsing and both resolution models; Playwright covers a rendered embed in both suites
- [ ] All four gates green
