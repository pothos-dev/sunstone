---
status: done
---

# ov-17: Sources section and footnotes that open their source

**What to build:** a Concept that cites with `[^id]` against its `sources` Frontmatter list gets a readable bibliography and clickable citations, without the rest of [ov-10](ov-10-sources-provenance-family.md). Split out of ov-10 because real Bundles already cite this way and the citations were resolved but dead: nothing to click, nothing at the end of the document.

- [x] A shared Rust reading of `sources` in `sunstone-shared` (`sources.rs`: `sources`, `source_list`, `resource_kind`), used by the editor over wasm and by the native render directly (ADR 0006)
- [x] A `resource` is classified as a URL, a path (bundle-relative `/…` or relative, OKF §6.2), or a scope descriptor
- [x] A `[^id]` with a `sources` entry shows the entry's title, resource and signals on hover
- [x] A click on it opens the resource directly: a path opens the Concept in the Tile, a URL opens in the browser; a scope descriptor is not clickable
- [x] A virtual Sources section after the body lists the entries, cited ones by their footnote number, then uncited ones unnumbered in list order; the title opens the resource the same way. It is never written to the file
- [x] Editor (hybrid + reading), native render (web viewer, print) and the fake render emit it
- [x] Rust unit tests for the list and the render, fake render tests, a desktop Playwright spec
- [x] All four gates green

## Decisions

- A click on a citation opens the source itself, not the Sources entry. The intermediate jump to the list adds a step and nothing a reader needs; the details are on hover.
- Hover is a custom card (`src/lib/sourceCard.ts`), shown on `mouseenter` without delay, because the native `title` tooltip waits about a second and cannot be styled: number, kind, title, resource, then `author`, `last_modified`, `usage_count` when present. The editor attaches it to its widgets; in the web viewer the native render puts the entry on the element as `data-source` JSON and one delegated binding over the rendered body shows the same card.
- A label that is a `sources` id takes the source behaviour even when the body also defines it; hiding such a definition stays in ov-10.
- Resource paths resolve like markdown links (`resolve_location`): a leading `/` from the Bundle root, otherwise relative to the Concept. A value with whitespace and no path prefix is a scope descriptor.
- Still in ov-10: Edit on an entry, jumps from an entry back to its citing claims, `usage_window`, the `sources` lint rules, hiding body definitions, legacy deprecation work.
