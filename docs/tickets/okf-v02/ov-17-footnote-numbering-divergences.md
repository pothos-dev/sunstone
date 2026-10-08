---
status: captured
---

# ov-17: Footnote numbering and source-id matching diverge in edge cases

**What to build:** the numbers footnotes show, and whether a label matches a
`sources[].id`, agree with the spec and between the editor and the web view.
The 2026-10-08 nightly review of b5d2bfc found:

- ov-10 still says *"A numeric `[^n]` with no `sources` entry (migrated v0.1
  documents) keeps ov-14's behaviour: label as written"*, but the shared scanner
  now renumbers every label by first use: `A[^21] B[^2]` shows `[1] [2]`.
- The native render scans footnotes after `embeds_to_markers` has rewritten
  Embeds (`crates/sunstone-native/src/render/mod.rs`), the editor scans the raw
  body. A `[^a]` inside an Embed's alt text (`![chart[^a]](x.png) text[^b]`)
  shifts every later number in one surface but not the other.
- `footnotes::source_ids` reads YAML numbers as numbers, so `id: 007` becomes
  `"7"` and `[^007]` renders as dangling.
