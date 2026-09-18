# Attachment listing

Make a Concept show the non-image **[Attachments](/GLOSSARY.md)** it **Embeds** — a PDF, a
spreadsheet, an audio file — as a list at the bottom of the Concept, rather than as the
literal `![[report.pdf]]` text it renders today.

[embedded-images](/tickets/embedded-images/) makes image Attachments render **in place**
and is where the whole Attachment seam comes from: the URL-returning `Backend` method, the
desktop URI scheme, `/api/asset`, the separate Attachment index, and the Embed parser that
understands both `![alt](path)` and `![[name]]`. This effort adds a second *presentation*
over that seam and must not fork any of it.

Decisions that bind this effort:

- **Embeds only, not links.** A Concept that writes `[the report](report.pdf)` is linking,
  not embedding, and stays a plain link. Listing links too would blur the Embed/link
  distinction the glossary draws and duplicate Backlinks-adjacent UI.
- **All four surfaces** — `editing`, `read`, the web view and the print/PDF export. A
  listing that exists in only one of them is a Concept whose content changes depending on
  how you look at it.
- **The gesture is "open externally"** — the OS default application on desktop, a download
  on web. Sunstone does not preview non-image file types.
- **Images are never listed.** An image Embed renders in place, per
  [ADR-0010](/adr/0010-embeds-as-point-widgets-over-inline-preview.md); it does not also
  appear at the bottom.
