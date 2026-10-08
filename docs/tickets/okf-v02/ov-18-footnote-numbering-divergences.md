---
status: decide
priority: 1
---

# ov-18: Footnote numbering and source-id matching diverge in edge cases

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
- ~~`footnotes::source_ids` reads YAML numbers as numbers, so `id: 007` becomes
  `"7"`~~ Not a bug: checked while grounding, see below.

- [ ] Numeric labels render as decided in open question 1, and ov-10's bullet says the same
- [ ] A `[^label]` inside an Embed's alt text neither renders nor counts toward numbering, in the editor and the native and fake renders
- [ ] Shared-scanner tests (`cargo test`) and a `src/lib/ipc/fake/render.test.ts` case; all four gates green

## Grounding

- Numbering is assigned in `scan_footnotes` (`crates/sunstone-shared/src/footnotes.rs`):
  `num` is sequential by first reference, for every label. The editor
  (`src/lib/editor/footnotes.ts`), the native render
  (`crates/sunstone-native/src/render/footnotes.rs`) and the fake render
  (`src/lib/ipc/fake/render.ts`) all display that `num`; the label is only the
  hover title. ov-14's "render as written" decision is marked superseded;
  ov-10 line "A numeric `[^n]` with no `sources` entry … label as written" was
  not updated, and ov-10 is `ready`, so whoever builds it would get
  contradictory instructions.
- Embeds: `render/mod.rs` runs `embeds_to_markers` first, replacing each Embed
  (alt text included) with `![](sapembed:N)`, and only then
  `footnotes_to_sentinels` (over `sources::source_list`, since ov-17). The
  editor calls `scanFootnotes(doc.toString(), …)` on the raw document. So a footnote inside alt text is counted (and drawn) by
  the editor only. `sunstone_shared::embed::scan_embeds` already gives the Embed
  spans, so the shared scanner can skip them the way it skips code.
- `footnotes::source_ids` was probed with `id: 007`, `id: 1.0` and `id: '007'`: serde_yaml
  keeps all three as written (`"007"`, `"1.0"`, `"007"`). `sources::sources`
  (ov-17) parses the same way. Only a non-string,
  non-number id (`true`) is dropped, which is fine.
- Footnotes inside Embed alt text are rare in practice; this is priority 1.

## Open questions

1. **Numeric labels in Bundles without `sources`.** Shipped behaviour renumbers
   them (`A[^21] B[^2]` → `[1] [2]`); ov-10 says they keep the label as written.
   (a) Keep renumbering everywhere and correct ov-10's bullet. One rule; matches
   GFM, pandoc and Obsidian, which also number by first use.
   (b) Show the label for purely numeric labels when the Concept has no
   `sources`, as ov-10 says. Migrated v0.1 documents keep their printed numbers
   (which may match prose that cites "note 21").
   Recommendation: (a). It is what Daniel shipped on 2026-10-07 after seeing
   real Bundles, and it needs only a doc edit.

## Decisions

- Embed alt text → `scan_footnotes` skips Embed spans, like code. Fixes all
  three surfaces at once through the shared scanner instead of teaching the
  editor about render-side markers.
