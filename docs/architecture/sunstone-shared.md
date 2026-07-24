---
type: Package
title: sunstone-shared — the pure leaf crate (native + wasm)
description: The dependency-light Rust crate holding Sunstone's pure frontend-shared algorithms — link resolution, wikilink/slug, anchor rewrite, frontmatter parse, outline/CriticMarkup/citation scanners — compiled to both the native host and wasm32 so one source runs everywhere.
resource: crates/sunstone-shared
tags: [architecture, rust, crate, wasm, shared, domain]
timestamp: 2026-07-24T00:00:00Z
---

# sunstone-shared

`crates/sunstone-shared/` is Sunstone's **pure leaf crate** — the algorithms that
must give byte-identical answers in three places at once: the native backend, the
server-side renderer, and the browser editor's synchronous CodeMirror decorations.
It exists to end the TS↔Rust twin drift documented in
[ADR 0006](/adr/0006-wasm-shared-core-for-frontend-logic.md): one Rust source,
compiled to **both** the native host and **`wasm32`**, is the single source of
truth for link/frontmatter/render-derived logic.

Its dependencies are deliberately limited to `serde` / `serde_yaml` (plus the
`tsify` / `wasm-bindgen` DTO derives, gated behind the optional **`wasm` feature**
so the native build never pulls them in). Nothing native-only — `ignore`,
`notify`, `grep-*`, `dirs`, `comrak` — may ever land here, or the wasm build
breaks. It is a leaf: it depends on no other Sunstone crate.

## Public surface

`src/lib.rs` is a module manifest; each module is one family of pure Bundle logic:

| Module | Responsibility |
| --- | --- |
| `links` | Markdown link resolution — `resolve_link` (→ `ResolvedLink`, `internal` carries `exists`), `find_bundle_root`, `RewriteBody`, `WikilinkTarget`. |
| `wikilink` | `[[name]]` parsing (`parse_target`, `parse_target_parts`) and **name-based** resolution (`resolve_wikilink`) — case-insensitive, basename or path-suffix, shortest-path tie-break. |
| `slug` | GitHub-style heading `slugify` for anchor links (no de-duplication). |
| `rewrite` | Same-file and corpus-wide anchor rewriting (`rewrite_anchors_in`, `AnchorRename`, `AnchorRewrite`) plus pure rename/move path math. |
| `paths` | Pure path helpers — `to_rel_string`, `resolve_internal`, `is_external`, `find_byte` — shared so native tree/index/search and the browser cannot drift. |
| `frontmatter` | Verbatim `split` / `split_concept` (byte-preserving), `frontmatter_line_count`, and the index-parse kernels (`parse_frontmatter`, `frontmatter_fields`). |
| `outline` | ATX-only heading scan (`scan_headings` → `OutlineHeading`) and `find_heading_line`. |
| `critic` | CriticMarkup parse/group — `parse_critic_marks`, `pair_annotations`, `annotation_at` (offset-span structs). |
| `citations` | Inline citation scanning — `find_citation_refs`, `citation_def_pos`. |
| `url` | Concept path ↔ pretty viewer URL (`concept_url`, `url_to_concept`). |

## Two consumers, one source

The crate is compiled twice, by two different downstream crates:

- **[sunstone-native](/architecture/sunstone-native.md)** depends on it by path and
  **re-points its call sites here** (no re-export shim). `render.rs`, `index`,
  `rewrite`, `paths`, and `watcher` all call `sunstone_shared::*` for the pure
  kernels; native keeps only the IO, index, git, search, and watcher machinery.
- **`sunstone-wasm`** (the bridge crate below) depends on it **only**, with the
  `wasm` feature on.

That is what makes the browser editor and the native backend agree by
construction: they run the *same* compiled algorithm, not two hand-kept twins.

## sunstone-wasm — the WebAssembly bridge

`crates/sunstone-wasm/` (`cdylib` + `rlib`) is the thin `wasm-bindgen` entry
point. It depends on `sunstone-shared` **only** and is compiled to `wasm32` via
`wasm-pack build --target web`, whose `pkg/` output lands at the gitignored
`src/lib/wasm/pkg`. On the native host its exports are inert — `cargo check` here
only proves the toolchain compiles.

It exposes two shapes over the shared kernels:

- **The `BundleIndex` handle** — a stateful object that lives inside wasm and
  **owns the saved concept-path set** plus the derived membership set and OKF
  bundle root. Its methods (`resolveLink`, `resolveWikilink`, `bundleRoot`,
  `exists`, `conceptPaths`, `rewriteAnchorsIn`, `urlToConcept`) are synchronous
  JS→wasm→JS calls with no callback crossing — so CodeMirror decorations resolve
  against the **live, unsaved buffer** (`currentPath` passed per call) with the
  same code that runs natively.
- **Free (handle-less) exports** — per-call kernels for frontmatter
  (`splitFrontmatter`, `parseFrontmatter*`), render-derived scanners
  (`scanHeadings`, `parseCriticMarks`, `findCitationRefs`, `conceptToUrl`,
  `slugify`), and the fake backend's corpus-walking variants (`resolveLinkIn`,
  `rewriteAnchors`, …) that take an explicit path-set rather than the handle's.

The frontend loads and calls all of this through `src/lib/wasm/` — see the
[web frontend](/architecture/web-frontend.md#the-wasm-seam).

## Design constraints

- **Compiles for `wasm32`.** No native-only dependency may be added; the wasm
  DTO derives stay behind the optional `wasm` feature so native builds skip them.
- **Byte-preservation holds.** `frontmatter::split*` returns verbatim slices, so
  an unchanged Concept recombines byte-for-byte after an edit round-trip.
- **ATX-only headings.** The outline scan is pure ATX; setext headings are not
  recognized (a deliberate, OKF-aligned behaviour change — see ADR 0006).
- **Render stays out.** `comrak`/`regex` would balloon the wasm bundle, so
  server-side HTML render lives in [sunstone-native](/architecture/sunstone-native.md)'s
  `render` module; the browser uses the pure scanners only.

## Relationships

- Consumed natively by [sunstone-native](/architecture/sunstone-native.md) (the IO
  crate re-points its pure call sites here) and compiled to wasm by
  `sunstone-wasm` for the [web frontend](/architecture/web-frontend.md).
- Realizes the pure half of the [Linking](/okf/linking.md) model; its rationale and
  the per-family migration are recorded in
  [ADR 0006](/adr/0006-wasm-shared-core-for-frontend-logic.md).
- The [overview](/architecture/overview.md) shows how the shared crate sits under
  both hosts; its build wiring and seam tests are in [Testing](/architecture/testing.md).
