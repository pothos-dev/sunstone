---
status: needs-triage
priority: 1
blocked-by: [ei-1]
---

# al-1: Non-image Attachments listed on a Concept

**What to build:** a Concept that **Embeds** a non-image **[Attachment](/GLOSSARY.md)** —
`![[report.pdf]]`, `![notes](./notes.csv)` — shows it in a list at the bottom of the
Concept instead of rendering the raw Embed text, and opening an entry hands the file to the
OS default application (desktop) or downloads it (web). The list appears in `editing`,
`read`, the web view and the print/PDF export.

[ei-1](/tickets/embedded-images/ei-1-embedded-images-in-concepts.md) built everything this
needs and restricted itself to images: the URL-returning `Backend` method, the desktop URI
scheme, `GET /api/asset`, the separate Attachment index, the Embed parser covering both
syntaxes, and the path confinement. This ticket is a second presentation over that seam,
not a second seam.

Note the `blocked-by` is real: until ei-1 lands, a non-image Embed keeps rendering as
literal text, which is the current behaviour and is fine.

- [ ] A non-image Embed no longer renders as raw `![[ … ]]` or `![ … ]( … )` text
- [ ] Every non-image Attachment a Concept Embeds appears once in a list at the bottom of that Concept
- [ ] The list renders in `editing`, `read`, the web view and the print/PDF export
- [ ] Opening an entry uses the OS default application on desktop and downloads on web
- [ ] Image Embeds render in place and never appear in the list
- [ ] An Embed of a file that does not exist shows the same error styling as a broken image Embed
- [ ] All four gates green

## Open questions

Not yet grounded. The shape below is what the grilling session settled; the rest needs a
pass over the code.

1. Does an `![[some-concept.md]]` Embed — a Concept, not an Attachment — belong in this
   list, become a plain link, or stay deferred for real transclusion? The glossary calls an
   Attachment a **non-`.md`** file, so a Concept Embed is arguably neither case. My
   recommendation: a plain working link, since the target resolves and a "broken" or
   "attachment" affordance for a live Concept would be a lie.
2. Is the list authored content (part of the Concept's markdown, and therefore committed)
   or chrome (derived, like the **Outline**)? Chrome is the obvious answer, but it decides
   whether the print/PDF export gets it for free or needs a renderer change.
