# Embedded images

Make image **[Attachments](/GLOSSARY.md)** stored in a Bundle render inside the Concept
that **Embeds** them, in `editing` mode, `read` mode, the server-rendered web view and the
print/PDF export. Today an Embed either shows raw (`![[ … ]]`, deferred by
[ADR-0004](/adr/0004-wikilinks-optional-secondary-name-based.md)) or renders a broken
`<img>` (`![alt](x.png)`, whose bundle-relative `src` the webview cannot fetch).

Decisions that bind both tickets:

- **This is a Sunstone extension, not OKF.** The spec says nothing about images, media or
  attachments — §3 describes a Bundle as a tree of markdown files and leaves non-`.md`
  files unspecified rather than forbidden. The behaviour belongs in the deviation table in
  [`docs/okf/bundle.md`](/okf/bundle.md).
- **Obsidian is the reference behaviour**, for the reason ADR-0004 gives: the Bundles that
  carry Embeds came from Obsidian vaults. The one divergence from the wikilink grammar is
  that `|` in an Embed is a size, not an alias.
- **The bytes cross the seam as a URL, never as bytes** — a custom URI scheme on desktop,
  `/api/asset` on web, one `Backend` method that `tauri.ts`, `fake.ts` and `http.ts` all
  implement, and every resolved path confined to the Bundle root by the existing
  `bundle::resolve`. See
  [ADR-0011](/adr/0011-attachment-bytes-cross-a-custom-uri-scheme.md).
- **Rendering is a point widget over `inlinePreview`**, not the block-replace ADR-0005 uses
  for Diagrams — block when the Embed is alone on its line, inline when it is among text.
  See [ADR-0010](/adr/0010-embeds-as-point-widgets-over-inline-preview.md).
- **Attachments are invisible to the index.** They stay out of the Explorer tree, out of
  `md_files`, out of Backlinks, and out of `find_bundle_root`'s input — a separate index
  serves Embed resolution.

Out of scope: editing or generating images, pasting an image into a Concept, and any Embed
of a non-image file — that last one is [attachment-listing](/tickets/attachment-listing/),
which is blocked on the seam ei-1 adds.
