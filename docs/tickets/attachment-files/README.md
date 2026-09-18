# Attachment files

Make **[Attachments](/GLOSSARY.md)** — the non-`.md` files stored in a Bundle — work inside
the Concepts that **Embed** them, across all four surfaces: `editing` mode, `read` mode, the
server-rendered web view and the print/PDF export.

Three tickets, one seam:

- **[af-1](af-1-embedded-images-in-concepts.md)** — image Embeds render in place, in both
  syntaxes. Builds the whole Attachment seam the other two stand on.
- **[af-2](af-2-theme-aware-svg-embeds.md)** — an embedded SVG that leaves its colours
  unspecified inherits the app palette, which means inlining its markup and therefore
  sanitising it and shipping a CSP.
- **[af-3](af-3-non-image-attachments-listed-on-a-concept.md)** — a non-image Attachment
  (a PDF, a spreadsheet) is listed at the bottom of the Concept and opens externally.

Decisions that bind the whole effort:

- **This is a Sunstone extension, not OKF.** The spec says nothing about images, media or
  attachments — §3 describes a Bundle as a tree of markdown files and leaves non-`.md` files
  unspecified rather than forbidden. The behaviour belongs in the deviation table in
  [`docs/okf/bundle.md`](/okf/bundle.md).
- **Obsidian is the reference behaviour**, for the reason
  [ADR-0004](/adr/0004-wikilinks-optional-secondary-name-based.md) gives: the Bundles that
  carry Embeds came from Obsidian vaults. The one divergence from the wikilink grammar is
  that `|` in an Embed is a size, not an alias.
- **The bytes cross the seam as a URL, never as bytes** — a custom URI scheme on desktop,
  `/api/asset` on web, one `Backend` method that `tauri.ts`, `fake.ts` and `http.ts` all
  implement, and every resolved path confined to the Bundle root by the existing
  `bundle::resolve`. See [ADR-0011](/adr/0011-attachment-bytes-cross-a-custom-uri-scheme.md).
- **Rendering is a point widget over `inlinePreview`**, not the block-replace ADR-0005 uses
  for Diagrams — block when the Embed is alone on its line, inline when it is among text.
  See [ADR-0010](/adr/0010-embeds-as-point-widgets-over-inline-preview.md).
- **Attachments are invisible to the index.** They stay out of the Explorer tree, out of
  `md_files`, out of Backlinks, and out of `concept_paths()` — a separate Attachment index
  serves Embed resolution.
- **Embeds only, never links.** A Concept writing `[the report](report.pdf)` is linking, not
  embedding, and stays a plain link. That distinction is what the glossary's **Embed** entry
  draws, and af-3 must not blur it by listing linked files too.
- **Remote Embeds are click-to-load and `data:` Embeds do not render.** Opening a Concept
  must never fire a tracking pixel from a reader's browser and IP — on the web shell the
  author and the reader are different people.

Out of scope for the effort: editing or generating Attachments, pasting an image into a
Concept, and previewing a non-image Attachment's contents (af-3 lists and opens it; it does
not render it).
