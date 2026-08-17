# WebAssembly-shared core for frontend logic

We compile the **pure algorithms** that today exist as drifting TS↔Rust twins into a
single **WebAssembly** module, loaded synchronously inside both the Tauri WebView and the
SvelteKit web client, and **delete the TS copies**. Rust becomes the one source of truth
for link resolution, frontmatter parsing, and the render-derived scanners (outline,
CriticMarkup, citations); the frontend calls that logic in-process, synchronously, with no
IPC round-trip.

The move is **additive to the frontend process only**. The Tauri desktop backend
(`src-tauri`) and the SSR web renderer (`sunstone-server`, `render.rs`) keep running native
Rust — wasm never replaces them. `cargo test` stays the behavioural coverage gate, and
frontend backend access stays behind the `src/lib/ipc/` seam.

This ADR records the full plan: toolchain, packaging, the marshalling seam, the ownership
and load model, the type-generation and test strategies, the size budget, and the ordered,
per-family migration with its explicit delete-vs-keep list and an executable checklist. It
is the hand-off artifact for a separate build effort — **no production code is written by
the planning effort that produced it.**

## Motivating constraint

CodeMirror decorations run **synchronously** and cannot `await` IPC
(`src/lib/editor/broken-links.ts:19`), and they must resolve against the **live, unsaved
buffer**, not the on-disk file. A twin of the Rust logic reimplemented in TS is the only way
that works today — and it drifts. Running the *same* logic in-process via wasm is the only
way to satisfy the synchronous-live-buffer constraint with a single implementation. Every
decision below serves that constraint.

## Considered Options

- **WASM-shared core (chosen)** — one Rust source compiled to both native and wasm; the
  frontend loads the wasm and calls it synchronously after a one-time async `init()`.
- **Keep the TS twins, accept the drift** — status quo; the recurring source of link- and
  frontmatter-resolution bugs this effort exists to kill.
- **Reverse consolidation (drop Rust, keep TS)** — rejected in prior discussion: the backend
  index, the `backlinks` command, and the SSR renderer all require native Rust.
- **Feature-flagged dual-path coexistence during migration** — rejected (see *Migration*):
  a runtime switch forces both impls onto the synchronous decoration path and re-creates the
  very live twin the effort removes.

## Decisions

### 1. Build toolchain

`sunstone-core` as a whole will **not** compile for `wasm32` (it drags in `ignore`,
`notify`, `grep-*`, `dirs`). We build wasm from a thin pure subset (see *Packaging*) via
**`wasm-pack build --target web`**, wired into Vite with `vite-plugin-wasm` +
`vite-plugin-top-level-await`. Load is **browser-only** (SSR stays native Rust); a single
`await init()` up front yields synchronous exports thereafter. `wasm-pack`'s `pkg/` output
lands at a **gitignored** `src/lib/wasm/pkg`, and a `build:wasm` step runs **before**
check / unit / Playwright. The four `cargo` gates are unaffected.

### 2. Crate packaging — the pure leaf triad

Feature-flagging and a plain wrapper are both dead ends (a wrapper on `sunstone-core` still
drags the native-only deps into `wasm32`, and pure/IO code shares modules so per-function
gating is a trap). Instead, **extract a pure leaf crate**:

- **`sunstone-shared`** — leaf, compiles native **and** wasm; deps limited to
  `serde` / `serde_yaml`. Holds wikilink / slug / rewrite / index-frontmatter / index-links
  logic + pure `paths`.
- **`sunstone-native`** — renamed from `sunstone-core`, native-only (the IO/backend crate).
- **`sunstone-wasm`** — `cdylib` + `rlib`, depends on `sunstone-shared` **only**; the wasm
  entry point.

Call sites are updated directly — no re-export shim. `render.rs`'s pure scanners are folded
into `sunstone-shared` as part of family 13, not up front.

### 3. Marshalling & exported API

The boundary is **handle-oriented**: a `BundleIndex` object lives inside wasm and owns the
concept-path set; per-keystroke `resolveLink` is a JS→wasm→JS call with **no** callback
crossing (pass-per-call and callback designs both rejected). Mechanism is
**`serde-wasm-bindgen` + `tsify`**, chosen to auto-generate `.d.ts` from the Rust structs
(killing DTO drift — see *Types*), not for raw speed. Convention: camelCase `js_name`;
internally-tagged enums for `ResolvedLink`.

The `BundleIndex` handle surface (single source of truth for the link family):

- `resolveLink(currentPath, href) -> ResolvedLink` — `internal` variant carries `exists`.
- `resolveWikilink(currentPath, rawTarget) -> {path} | null` — set stays in-wasm.
- `bundleRoot() -> string` — replaces the `#rootCache` memo.
- `exists(path) -> bool` — internal membership, also callable.
- `rewriteAnchorsIn(sourcePath, body, renames) -> { content }` — synchronous **live-buffer**
  op (body-in / body-out).
- `conceptPaths() -> string[]` — single source of the membership set.
- `urlToConcept(urlPath) -> path | null` — added by family 13 (retires `collectFilePaths`).

Plus **free** (handle-less) exports: `splitFrontmatter` / `frontmatterLineCount`,
`scanHeadings` / `findHeadingLine`, `parseCriticMarks` / `pairAnnotations` / `annotationAt`,
`findCitationRefs` / `citationDefPos`, `conceptToUrl`.

**Three boundary shapes** proven by the seed and copied by later families: **per-call
scalar**, **body-in / body-out**, **set-list-out**. A fourth, **spans-out** (offset-span
structs), carries the decoration seam (family 13).

### 4. Index ownership & lifecycle

`indexStore` owns **one** `BundleIndex` handle that *is* the resolution engine. Lifecycle
reuses today's coarse **wholesale-rebuild + `version`-bump** seam verbatim (triggers:
mount / `file-changed` / CRUD — **not** Concept switch), with one new rule: **`.free()` the
old handle on swap**. Membership is the **saved on-disk set only**; the unsaved buffer stays
out (`currentPath` is passed per call), preserving today's behaviour. `pathList` never
crosses the boundary — the handle owns both the set and the operations over it.

### 5. Module init & load ordering

`await init()` lives **inside `indexStore.refresh()`** via a memoized, `browser`-guarded
`ensureWasm()` awaited before the handle is built — **not** in any `+layout`/`load`. The
single client entry point (`App.svelte`, mounted on the web via `WebAppShellIsland`; the
former `WebEditorIsland` has been removed) already calls
`refresh()` first, so there is zero new wiring. SSR exclusion is by **dynamic `import()` +
`browser`** guard (SSR renders native Rust; `WebViewer` imports neither the store nor
`Tile`). The editor mounts eagerly; readers no-op on a null handle and the existing
**`version`** rune re-runs decorations once wasm is ready. Load failure **degrades**
gracefully (silent styling no-op + dismissible banner + retry) — never a dead page.

### 6. DTO / type-generation strategy

**Every** "matches the Rust" DTO becomes generated, split by boundary:

- **tsify** emits the ~5 wasm DTOs (`sunstone-shared`).
- **ts-rs** emits the ~8 IPC-only DTOs (`sunstone-native`).
- Types crossing **both** (`RewriteSummary`, `AnchorRename`, `OutlineHeading`,
  `FrontmatterField`) are **tsify-canonical**; ts-rs *type-imports* them (one definition;
  erases on SSR).

`$lib/types` stays a **re-export barrel** (zero call-site churn) and still hand-defines
TS-only shapes like `Frontmatter`. Both generated outputs are gitignored; a **`build:types`**
step (wasm-pack + the `cargo test` ts-rs export) runs before check / unit / Playwright.

### 7. Test & coverage strategy

- **Algorithm goldens → `cargo test` wholesale.** Delete every pure-algorithm TS twin **and
  its test** — no TS-side mirroring (that is a test-twin).
- **`bun test src/lib`** keeps two jobs: the JS↔wasm **seam** (marshalling contract +
  `.free()` lifecycle, via a ~3-line Node shim that byte-loads the *shipping* `--target web`
  `pkg/` — tested = shipped) and **TS-only** logic with no Rust source.
- **Playwright**: desktop suite is the **primary** wasm behavioural guard (real wasm + fake
  IPC + live-buffer decorations); web e2e is **secondary** (real wasm + native Rust + SSR).
  No net-new specs.
- **No standing parity harness.** Equivalence is a **throwaway cut-over check** owned by each
  migration PR. The four gates are unchanged.

### 8. Bundle-size & cold-start budget

Core-minus-render wasm is ~150–350 KB (~50–130 KB brotli) with single-digit-ms cold start —
fine. `comrak` + `regex` would balloon it to ~1.5 MB, so **render is deferred out of wasm
v1**; outline is a pure string scan instead. **Budget: core ≤ 400 KB / ≤ 150 KB brotli.**
Estimates are cited; a one-afternoon spike confirms them during Step 0.

## Migration plan

### Coexistence, parity, rollback

**Clean-cut-per-PR — no dual-path / feature-flag coexistence.** Each family crosses in a
single PR that (a) lands the Rust in `sunstone-shared`, (b) wires wasm at the frontend seam,
(c) **deletes the TS twin + its unit test in the same PR**, and (d) merges only with all four
gates + Playwright green.

- **Parity gate**: a **throwaway cut-over** step inside each PR — run that twin's existing
  goldens through the new wasm once, confirm byte-identical, then delete impl + test.
- **Rollback**: `git revert` the family PR. A family that can't cross cleanly simply does not
  merge (its Rust may still land in `shared`, unused). Per-family PRs keep each revert
  surgical.

### Ordered sequence

**Step 0 — Pipeline stand-up (prerequisite, separate PR).** Stand up the crate triad (§2),
`wasm-pack` + Vite wiring (§1), the `build:wasm` / `build:types` gate ordering (§1/§6), and
the `indexStore.ensureWasm()` / `.free()` seam (§4/§5) — shipping one **dummy `BundleIndex`
export**, no real logic. This isolates toolchain risk from logic risk before any family
migrates, and is where the §8 size spike runs.

Then the families, in topological order:

1. **Family 10 — link family (the seed).** First real payload; establishes the marshalling +
   handle + parity-cut PR template every later family copies.
2. **Family 11 — frontmatter** and **Family 13 — render-derived + CM-decoration seam** —
   both copy the seed template. **13 is the hard one** (decoration seam; the only family that
   edits native SSR `render.rs`).
3. **Family 12 — fake backend** — after 10 & 11; it is a *consumer* of their shared source.
4. **Family 15 — path helpers** and **Family 16 — un-twinned TS** — parallel, off the
   critical path (disposition-only / scoping calls).
5. **This ADR** — records the plan.

Blocking edges enforcing the order: 11 & 13 depend on 10; 12 depends on 10 & 11.

### Per-family disposition

**Family 10 — link family.** Migrate `links.ts` (`resolveLink`, `resolveWikilink`,
`findBundleRoot`, `applyBundleRoot`, `normalizeSegments`, `splitWikilinkTarget`,
`isExternalLink`) and `anchorRewrite.ts` onto the `BundleIndex` handle. Beyond the twins, two
moves: **`rewriteAnchorsIn`** (a real synchronous live-buffer op in `Tile.handleSaved`) and
**`conceptPaths()`** (single source of the set, retiring `backend.listConceptPaths()` + the
`suggestions.conceptPaths` copy). Rewires `Tile.svelte` (`handleLinkClick`, `handleSaved`,
broken/wiki-link contexts), `editor/broken-links.ts`, `editor/wiki-links.ts`, and
`state/index.svelte.ts` (becomes the thin `indexStore` over the handle).

**Family 11 — frontmatter (four-way split).**
- **(A)** index-parse twins (`fake/frontmatter.ts`: `parseFrontmatter`,
  `parseFrontmatterFields/Keys`, `yamlValues`, `scalarString`) → **wasm**; the fake consumes
  the shared source.
- **(B)** `splitFrontmatter` + `frontmatterLineCount` → **wasm** as a pure free export
  (verbatim slices, so byte-preservation holds; foundational for 12/13).
- **(C)** the ADR-0003 **property model** (`parseProperties`, `classify`,
  `serializeFrontmatter`, `renameProperty`, `joinConcept`, `scaffoldConcept`,
  `titleFromFilename`, …) **stays TS** — no Rust twin, fed a content string (not wasm state),
  byte-preservation rides on the `yaml` CST tokens (`serde_yaml` has no spans), and it runs
  per-keystroke in `cm.ts`.
- **(D)** `stripTagsFromFrontmatter` **stays TS** (test-only, no twin) — folded into 12.

**Family 13 — render-derived + CM-decoration seam (maximalist single-source).** Pure kernels
(outline scan incl. the 3rd `fake/render.ts` copy; CriticMarkup parse/group; citation parse;
`conceptToUrl`) → `sunstone-shared` + wasm, delete TS. Native `render.rs` (SSR) is
**rewritten to consume the same shared functions** — critic/citation sentinels build from the
shared parse, and outline uses one pure ATX `scan_headings` everywhere (so
`inject_heading_ids` re-aligns to the scan list; **setext headings are dropped — ATX only**).
`urlToConcept` becomes a handle method (retires `collectFilePaths`); `conceptTitle` /
`nameFromPath` stay TS. **Seam**: wasm returns **offset-span structs**; the TS view/authoring
layers (`criticMarkupView`, `changeMarkDecorations`, `insertHighlightComment`, citation
widget) stay TS, thin over them. This family also **deletes `slug.ts`** (completing 10's
deferral). HTML render goldens are the SSR regression guard; the setext / id-injection
alignment is the sharp edge.

**Family 12 — fake backend (layer, not module).**
- **Layer 1** pure kernels (link / rewrite / frontmatter-index twins) → **consume the wasm
  barrel, delete the TS re-impl** (a divergent fake is exactly the banned test-twin). This
  happens *inside* the 10/11/13 PRs as they flip the fake's imports — **12 writes no PR of
  its own.**
- **Layer 2** backend-command orchestration (`search`, `backlinks`, `allTags`,
  `conceptsByTag`, `renderConcept` HTML assembly, tree CRUD, git seam) → **stays hand-rolled
  TS** (twins the *native* backend commands, kept native by design; freely walks the
  in-memory corpus over the Layer-1 kernels). Exempt-stays-TS: `stripTags` (test-only),
  `search` (fs ripgrep), `render` (comrak deferred), `tree` (IO), and `fake/store.ts`'s
  `FILES`/`FOLDERS` (fixture source that *feeds* the handle).

**Family 15 — path helpers.** **`path.ts` stays entirely TS; zero helpers migrate.** Both
families in it fail the criterion: trivial synchronous UI string ops
(`basename`/`dirname`/`stripMd`/`isMarkdownName`/`ensureMd`/`joinPath`/`splitPath` —
`dirname`'s Rust echo `dir_of` is now a private helper *inside* wasm's `resolve_internal`, so
no twin survives), and subtree-prefix remaps over frontend-only session state
(`remapPath`/`remapPaths`/`moveDestination` keep expanded-folders / recents / nav-history /
open-docs / drag-drop valid — never cross the handle).

**Family 16 — un-twinned pure TS.** **End-state: every un-twinned module stays TS; nothing
ports.** `fuzzy.ts` (also ranks tags, not in the handle — fed `conceptPaths()` instead),
`highlight.ts` / `textFormat.ts` / `mermaidBlocks.ts` / `mermaidTheme.ts`, `reserved.ts`,
`diffToCriticMarkup.ts` (only *consumes* 13's shared parser), and `scaffoldConcept` /
`titleFromFilename` all keep TS — porting any would *manufacture* a new twin. The one active
consequence is a **rewire, not a port**: `suggestions.svelte.ts` / `QuickNav` drop the
`listConceptPaths()` IPC + its `$state` copy and read the handle's `conceptPaths()` (executed
inside the family-10 PR).

## TS files: deleted vs kept

**Deleted (logic moves into `sunstone-shared` / wasm):**

- `links.ts` (whole) + `links.test.ts` — family 10.
- `anchorRewrite.ts` (whole) + `anchorRewrite.test.ts` — family 10.
- `slug.ts` (whole) + test — family 13 (logic already in `slug.rs`, wasm-internal).
- `outline.ts` (whole) + test — family 13.
- `citations.ts` (whole) + test — family 13.
- `editor/criticMarkup.ts` — the **parse half** (`parseCriticMarks` / `pairAnnotations` /
  `annotationAt`) + tests — family 13.
- `web/conceptUrl.ts` (`conceptToUrl` / `urlToConcept` / `collectFilePaths`) — family 13.
- `fake/render.ts::headingMatch` (the 3rd outline copy) — family 13.
- `fake/frontmatter.ts` index-parse fns (`parseFrontmatter` / `…Fields` / `…Keys` /
  `yamlValues` / `scalarString`) + tests — family 11/12.
- `frontmatter.ts` split fns (`splitFrontmatter` / `frontmatterLineCount`) + tests —
  family 11 (become free wasm exports).
- `backend.listConceptPaths()` IPC method + the `suggestions.conceptPaths` `$state` copy —
  family 10/16 (rewire, not a code move).

**Kept as TS (fed the wasm data where relevant):**

- `frontmatter.ts` **property model** (`parseProperties`, `classify`, `serializeFrontmatter`,
  `joinConcept`, `renameProperty`, `scaffoldConcept`, `titleFromFilename`, …) — family 11-C.
- `path.ts` (all ten helpers) — family 15.
- `fuzzy.ts`, `highlight.ts`, `editor/textFormat.ts`, `editor/mermaidBlocks.ts` /
  `mermaidTheme.ts`, `reserved.ts` (+ `reservedStub`), `diff/diffToCriticMarkup.ts` —
  family 16.
- `web/conceptUrl.ts::{conceptTitle, nameFromPath}` — family 13 (read the `RenderPayload`).
- CM view/authoring layers: `criticMarkupView.ts`, `editor/citations.ts` widget,
  `changeMarkDecorations`, `insertHighlightComment` — rewired to call the wasm parse.
- `fake.ts` Layer-2 orchestration (`search`, `backlinks`, `allTags`, `conceptsByTag`,
  `renderConcept` assembly, `tree.ts`, git seam), `fake/frontmatter.ts::stripTagsFromFrontmatter`,
  `fake/store.ts` `FILES`/`FOLDERS` — family 12.

## Executable migration checklist

1. **Step 0 — pipeline** (own PR): create the `sunstone-shared` / `sunstone-native` /
   `sunstone-wasm` triad; wire `wasm-pack --target web` + Vite plugins; add `build:wasm` +
   `build:types` before the check/unit/Playwright gates; add `indexStore.ensureWasm()` +
   `.free()`; ship a dummy `BundleIndex` export; run the §8 size spike. Gates + Playwright
   green.
2. **Family 10 — link family** (seed): land the Rust in `sunstone-shared`; expose the handle
   surface (§3); rewire consumers; run `links`/`anchorRewrite` goldens through wasm once;
   delete `links.ts` + `anchorRewrite.ts` + tests; do the `conceptPaths()` rewire. Gates +
   Playwright green; else revert.
3. **Family 11 — frontmatter**: land index-parse fns + `splitFrontmatter`; wire the fake to
   the shared source; expose the free split export; parity-check; delete the (A)/(B) TS twins
   + tests. Property model untouched.
4. **Family 13 — render-derived**: land the kernels; **rewrite `render.rs` to consume them**
   (critic/citation sentinels + `scan_headings` + `inject_heading_ids` re-alignment) with
   HTML goldens byte-identical; expose the wasm surface + `urlToConcept`; rewire the TS
   view/authoring layers + web routing; parity-check; delete the TS twins + `slug.ts` +
   tests. Both Playwright suites green. **Watch the setext / id-injection edge.**
5. **Family 12 — fake backend**: no standalone PR — verify each of 10/11/13 flipped the
   fake's Layer-1 imports to the shared barrel; confirm Layer-2 stays TS.
6. **Family 15 / 16** (parallel, off critical path): confirm `path.ts` and the un-twinned
   modules stay TS; ensure the `conceptPaths()` rewire (16) rode in with the family-10 PR.
7. Confirm the four gates + both Playwright suites are green on `main` after each merge;
   `git revert` any family that can't cross cleanly.

## Consequences

- **Single source of truth** for link/frontmatter/render-derived logic; the recurring
  TS↔Rust drift class of bugs is designed out, and CodeMirror decorations resolve
  synchronously against the live buffer with the same code that runs natively.
- **One new async gate at frontend startup** (`init()`), mitigated by memoization, the
  `browser` guard, graceful degradation, and the existing `version`-rune re-run.
- **New build steps** (`build:wasm`, `build:types`) precede the frontend gates; the four
  `cargo`/`bun`/`check` gates themselves are unchanged.
- **Render stays out of wasm (v1).** `comrak` is too large; the fake renderer stays a TS
  stand-in, and outline is a pure ATX string scan. Revisit only if a later effort accepts the
  render-wasm size.
- **Setext headings are dropped from the outline** on both editor and SSR sides (OKF/Obsidian
  is ATX-only) — a deliberate, spec-aligned behaviour change landing with family 13.
- **Out of scope** (returns only if the destination is redrawn as a fresh effort): landing any
  real wasm code (this ADR is plan-only); the reverse consolidation (drop Rust, keep TS); and
  the **JWT twin** (`server/jwt.ts` ↔ `auth.rs`) — it runs in the SvelteKit `/api` hook
  (Node), not the browser frontend the wasm seam targets.
- **Possible follow-up, not this effort**: unify concept scaffolding into the native
  `create_concept` command so desktop / web / fake share one stub — a backend refactor,
  orthogonal to this additive frontend seam.
