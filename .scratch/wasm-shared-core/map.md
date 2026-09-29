# Map — WASM-shared core

## Destination

A locked, hand-off-ready **plan** (an ADR under `docs/adr/` plus resolved decision
tickets) for:

1. compiling `crates/sunstone-core`'s pure algorithms to **WebAssembly**,
2. establishing the frontend **build → load → marshalling** seam so the wasm module
   runs synchronously inside both the Tauri WebView and the SvelteKit web client,
3. **migrating every duplicated TS/Rust twin** to that single wasm source of truth
   and **deleting the TS copies**.

Scope is *full migration*, but the deliverable is *plan only* — this effort writes
**no production code**. The way is clear when every decision below is resolved and
the ADR captures them.

## Notes

- **Domain**: CLI-launched Tauri 2 + SvelteKit (Svelte 5 runes) + Rust markdown
  editor with OKF support. See root `AGENTS.md`, `docs/GLOSSARY.md`, `docs/linking.md`.
- **Deliverable is plan-only** (wayfinder default). Tickets resolve *decisions*, not
  code. The one build artifact allowed is the ADR + this map.
- **Hard constraints** every ticket must respect:
  - Must NOT regress the native builds: the Tauri desktop backend (`src-tauri`) and
    the SSR web renderer (`sunstone-server`, `render.rs`) keep using native Rust.
    Wasm is additive, for the *frontend process only*.
  - Keep `cargo test` as the behavioural coverage gate (root `AGENTS.md`).
  - Honour the IPC seam rule: frontend backend access stays behind `src/lib/ipc/`.
  - The binding constraint that motivates all of this: CodeMirror decorations run
    synchronously and cannot `await` IPC (`src/lib/editor/broken-links.ts:19`), and
    must resolve against the **live unsaved buffer** — so the shared logic must run
    in-process, synchronously, in the frontend. Wasm is the only way to satisfy that
    with a single implementation.
- **Migration criterion** (two-pronged; from [10](issues/10-migrate-link-family.md)):
  migrate logic into wasm if **(a)** it's a *twin* of Rust logic (drift kill), **or**
  **(b)** it's frontend-only but *operates over state resident in the wasm handle*
  (the handle owns the set *and* the ops over it — generalizes 04's "pathList never
  crosses"). Counterweight: (b) never justifies creating a *new* twin — a util that
  also serves non-wasm data stays TS and is *fed* the wasm-resident data.
- **Skills to consult**: `/grilling` + `/domain-modeling` (default for decisions),
  `/research` (AFK external-knowledge tickets), `/prototype` (fidelity on API shape).
- Research artifacts live under `.scratch/wasm-shared-core/research/` (not a throwaway
  git branch — the working tree is dirty on `feat/enable-web-writing`).

## Decisions so far

<!-- one line per resolved ticket; zoom the link for detail -->

- [01 WASM build toolchain](issues/01-wasm-build-toolchain.md) — `sunstone-core` whole
  won't build for wasm32 (`ignore`/`notify`/`grep-*`/`dirs`); add a thin
  **`crates/sunstone-wasm`** (`cdylib`+`rlib`) over the pure subset. **`wasm-pack build
  --target web`** + Vite `vite-plugin-wasm`/`top-level-await`; **browser-only** load
  (SSR stays native Rust); `await init()` once ⇒ sync exports. `pkg/` → gitignored
  `src/lib/wasm/pkg`; `build:wasm` runs before check/unit/Playwright; cargo gates unaffected.
- [02 Crate packaging](issues/02-crate-packaging.md) — feature-flag & plain-wrapper both
  dead (a wrapper on `sunstone-core` still drags `ignore`/`notify`/`grep`/`dirs` into
  wasm32; pure & IO code share modules so per-fn gating is a trap). **Extract a pure leaf
  crate**: triad **`sunstone-shared`** (leaf, native+wasm, deps serde/serde_yaml) ←
  **`sunstone-native`** (renamed from `sunstone-core`, native-only) & **`sunstone-wasm`**
  (cdylib, depends on `shared` only). `shared` gets wikilink/slug/rewrite/index-frontmatter/
  index-links + pure `paths`; `render.rs` pure scanners deferred to
  [13](issues/13-migrate-render-derived-family.md). Call sites updated directly (no re-export shim).
- [03 Marshalling & exported API shape](issues/03-marshalling-api.md) — boundary is
  **handle-oriented** (`BundleIndex` held in wasm; per-keystroke `resolveLink` is
  JS→wasm→JS only, `exists` internal — pass-per-call callback rejected). Mechanism
  **`serde-wasm-bindgen` + `tsify`** (chosen to auto-generate `.d.ts` from Rust structs
  → kills DTO-drift, enabling [06](issues/06-dto-type-generation.md); not for speed).
  camelCase `js_name` convention; internally-tagged enums for `ResolvedLink`. Paper
  prototype at [`prototypes/03-marshalling/`](prototypes/03-marshalling/README.md);
  unblocks [04](issues/04-index-ownership.md) (lifecycle) & [06](issues/06-dto-type-generation.md).
- [04 Index/state ownership & lifecycle](issues/04-index-ownership.md) — **`indexStore`
  owns one `BundleIndex` handle that IS the resolution engine** (holds the set; exposes
  `resolveLink` + `resolveWikilink` + `bundleRoot`; `pathList` never crosses — kills the
  wikilink twin too). Lifecycle reuses today's coarse **wholesale-rebuild + `version`-bump**
  seam verbatim (triggers: mount / `file-changed` / CRUD — **not** Concept switch); one new
  rule: **`.free()` the old handle on swap**. Membership = **saved on-disk set only**, buffer
  stays out (`currentPath` per-call) — behavior-preserving. `resolveLink`'s `internal` variant
  gains **`exists: boolean`** (folds 03's verdict, no separate crossing). Unblocks
  [07](issues/07-test-coverage-strategy.md) & [09](issues/09-migration-sequencing.md).
- [05 Module init & load ordering](issues/05-init-load-ordering.md) — `await init()` lives
  **inside `indexStore.refresh()`** (the handle owner, 04) via a memoized, `browser`-guarded
  `ensureWasm()` awaited before the handle is built — **not** in any `+layout`/`load`. Both
  client entry points (`App.svelte`, dynamic-imported `WebEditorIsland`) already call
  `refresh()` first ⇒ zero new wiring. SSR-excluded by **dynamic `import()` + `browser`**
  (SSR renders native Rust; `WebViewer` imports neither store nor `Tile`). Editor mounts
  eagerly; readers no-op on a null handle and the existing **`version`** rune re-runs
  decorations once ready (web island also gates CodeMirror on init). Load failure **degrades**
  (silent styling no-op + dismissible banner + retry), never a dead page. **Purely additive** —
  confirms 01/03/04, changes nothing; folds into the ADR seam section.
- [06 Shared DTO / type-generation strategy](issues/06-dto-type-generation.md) — **every**
  "Matches the Rust" DTO becomes generated (full drift kill), split by boundary: **tsify**
  emits the ~5 wasm DTOs (`sunstone-shared`), **ts-rs** emits the ~8 IPC-only DTOs
  (`sunstone-native`). Types crossing both (`RewriteSummary`/`AnchorRename`/`OutlineHeading`/
  `FrontmatterField`) are **tsify-canonical**; ts-rs *type-imports* them (one definition;
  erases on SSR). `$lib/types` stays a **re-export barrel** ⇒ zero call-site churn (still
  hand-defines TS-only shapes like `Frontmatter`). Both outputs gitignored; a **`build:types`**
  (wasm-pack + `cargo test` ts-rs export) runs before `check`/unit/Playwright. Enum-tag
  fidelity folded into the deferred 03/08 spike.
- [07 Test & coverage strategy](issues/07-test-coverage-strategy.md) — **algorithm goldens
  → `cargo test` wholesale**; delete every pure-algorithm TS twin *and its test* (no TS-side
  mirroring — that's a test-twin). `bun test src/lib` keeps two jobs: the JS↔wasm **seam**
  (marshalling contract + `.free()` lifecycle, via a ~3-line Node shim byte-loading the
  *shipping* `--target web` `pkg/` — tested = shipped) and **TS-only** logic with no Rust
  source. Playwright: **desktop = primary** wasm behavioural guard (real wasm + fake IPC,
  live-buffer decorations), **web e2e = secondary** (real wasm + native Rust + SSR); no
  net-new specs. **No standing parity harness** — equivalence is a throwaway cut-over check
  owned by migration tickets 10–16. Four gates unchanged. Flags a constraint onto
  [12](issues/12-migrate-fake-backend-standins.md): fake backend must consume the shared source.
- [08 Bundle-size & cold-start budget](issues/08-bundle-size-budget.md) — core-minus-render
  wasm ~150–350 KB (~50–130 KB brotli), single-digit-ms cold start = fine; comrak+regex
  balloons to ~1.5 MB → **defer render out of wasm v1**, do outline as a pure string
  scan. Budget: core ≤ 400 KB / ≤ 150 KB brotli. Cited estimates; 1-afternoon spike to confirm.
- [09 Migration sequencing & rollback](issues/09-migration-sequencing.md) — **clean-cut-per-PR**,
  no dual-path/feature-flag coexistence: each family lands Rust + wires wasm + **deletes the TS
  twin & its test in one PR**, merges only on all gates green. **Rollback = `git revert`** the
  family PR; parity is 07's throwaway cut-over check inside each PR. Order: **Step 0** stands up
  the pipeline (crate triad + wasm-pack/Vite + build steps + seam) shipping a **dummy export** to
  isolate toolchain risk; then **[10](issues/10-migrate-link-family.md) link family (seed)** →
  [11](issues/11-migrate-frontmatter-family.md)/[13](issues/13-migrate-render-derived-family.md)
  (copy the seed template; 13 hardest) → [12](issues/12-migrate-fake-backend-standins.md) fake
  (consumer, after 10+11) → [15](issues/15-migrate-path-helpers.md)/[16](issues/16-untwinned-ts-logic.md)
  parallel/off-path → [17](issues/17-adr-assembly.md) ADR. Edges added: 11,13←10; 12←10,11.

- [10 Link family (the seed)](issues/10-migrate-link-family.md) — the end-to-end proof.
  `BundleIndex` handle exports the single-source link surface: `resolveLink`/`resolveWikilink`
  (per-call scalar, `exists` internal), `bundleRoot`, plus two migrations beyond the twins:
  **`rewriteAnchorsIn(sourcePath, body, renames)→{content}`** (Fork A — a real sync
  *live-buffer* op in `Tile.handleSaved`; body-in/body-out boundary; deletes `anchorRewrite.ts`)
  and **`conceptPaths()`** (Fork C — single source of the set, retires `backend.listConceptPaths()`
  + the `suggestions.conceptPaths` IPC copy). Establishes the **two-pronged migration criterion**
  (twin *or* touches-wasm-state; now in Notes) and 3 boundary shapes (scalar / body / set-list).
  **Deletes** `links.ts` + `anchorRewrite.ts` (+ tests). **Keeps/defers**: `slug.ts` (until
  [13](issues/13-migrate-render-derived-family.md) — `outline.ts` still uses it), `path.ts`
  ([15](issues/15-migrate-path-helpers.md)), `ipc/fake/links.ts` (Fork B →
  [12](issues/12-migrate-fake-backend-standins.md)), `fuzzy.ts` (stays TS, fed by handle;
  → [16](issues/16-untwinned-ts-logic.md)).

- [11 Frontmatter family](issues/11-migrate-frontmatter-family.md) — four-way split by the
  criterion: **(A)** index-parse twins (fake `parseFrontmatter`/`Fields`/`Keys`, `yamlValues`,
  `scalarString`) **→ wasm** (twins of `index/frontmatter.rs`+`render.rs`; fake calls shared
  source); **(B)** `splitFrontmatter` + `frontmatterLineCount` **→ wasm** as a *pure free export*
  (verbatim slices ⇒ byte-preservation holds; foundational for 12/13; not per-keystroke); **(C)**
  the ADR-0003 **property model** (parse/serialize/rename/scaffold round-trip) **stays TS** — the
  fuzzy.ts analogue: fails both prongs, byte-preservation rides on the `yaml` CST tokens
  (`serde_yaml` has no spans), and `serializeFrontmatter`/`joinConcept` run per-keystroke in `cm.ts`;
  **(D)** `stripTagsFromFrontmatter` stays TS (test-only, no twin) → deferred to
  [12](issues/12-migrate-fake-backend-standins.md).

- [13 Render-derived family + CM-decoration seam](issues/13-migrate-render-derived-family.md) —
  pure kernels (outline scan incl. the 3rd `fake/render.ts` copy; CriticMarkup parse/group;
  citation parse; `conceptToUrl`) → **`sunstone-shared` + wasm**, delete TS. **Maximalist
  single-source:** native `render.rs` (SSR) is **rewritten to consume the same shared fns** —
  critic/citation sentinels build from the shared parse, and outline uses one pure ATX
  `scan_headings` everywhere (⇒ `inject_heading_ids` re-aligns to the scan list; **setext
  headings dropped**, ATX-only). `urlToConcept` → wasm handle method (retires
  `collectFilePaths`); `conceptTitle`/`nameFromPath` stay TS. **Seam** = wasm returns
  **offset-span structs**; TS view/authoring layers (`criticMarkupView`, `changeMarkDecorations`,
  `insertHighlightComment`, citation widget) stay TS, thin over them. **Deletes `slug.ts`**
  (completes ticket 10's deferral). Only family that edits native `render.rs` → HTML goldens
  are the regression guard.

- [12 Fake backend stand-ins](issues/12-migrate-fake-backend-standins.md) — the cut runs by
  **layer, not module**: **Layer 1** pure kernels (link/rewrite/frontmatter-index twins) →
  **consume the wasm barrel, delete the TS re-impl** (a divergent fake is exactly 07's banned
  test-twin); **Layer 2** backend-command orchestration (`search`, `backlinks`, `allTags`,
  `conceptsByTag`, `renderConcept` HTML assembly, tree CRUD, git seam) → **stays hand-rolled
  TS** because it twins the *native* backend commands (kept native by design), freely walking
  the in-memory corpus over the Layer-1 kernels. Exempt-stays-TS confirmed: `stripTags`
  (test-only), `search` (fs ripgrep), `render` (comrak deferred/08), `tree` (IO), `store`
  `FILES` (fixture source that *feeds* the handle). **12 writes no PR** — each family PR
  (10/11/13) flips the fake's imports as part of its clean cut; 12's table is a column the
  ADR folds in, which is why it blocks only [17](issues/17-adr-assembly.md).

- [15 Path helpers disposition](issues/15-migrate-path-helpers.md) — **`path.ts` stays
  entirely TS; zero helpers migrate** (refutes the ticket's predicted `remapPath`/
  `moveDestination` migration). Two families, both fail the criterion: trivial synchronous UI
  string ops (`basename`/`dirname`/`stripMd`/`isMarkdownName`/`ensureMd`/`joinPath`/`splitPath`
  — `dirname`'s echo `dir_of` is now a private helper *inside* wasm's `resolve_internal`, no
  twin left), and subtree-prefix remaps over **frontend-only session state** (`remapPath`/
  `remapPaths`/`moveDestination` keep expanded-folders/recents/nav-history/open-docs/drag-drop
  valid — never cross the handle). The only Rust echo of remap is `build_move_map`'s
  `strip_prefix`, which lives in the *native* rename/move command ([12](issues/12-migrate-fake-backend-standins.md)).
  `path.ts` is the map's "fed the wasm data, stays TS" counterweight case. Recorded in the ADR
  under "what stays TS."

- [16 Un-twinned pure TS](issues/16-untwinned-ts-logic.md) — **end-state: every un-twinned
  module stays TS; nothing ports.** None is a twin (a) or touches wasm-handle state (b), so a
  port would *manufacture* a twin the counterweight forbids. `fuzzy.ts` (ranks tags too, not
  in the handle), `highlight.ts`/`textFormat.ts`/`mermaid*`, `reserved.ts` (basename `Set` —
  absurd to cross for it), `diffToCriticMarkup.ts` (no twin; only *consumes* 13's shared
  parser), and `scaffoldConcept`/`titleFromFilename` (no Rust twin — `create_concept` writes
  an empty file, frontend authors the stub; same family as 11 Fork C) all **keep TS**. One
  active consequence, a **rewire not a port**: `suggestions.svelte.ts`/`QuickNav` drop the
  `listConceptPaths()` IPC + its `$state` copy and read the handle's `conceptPaths()` (10 Fork
  C); `fuzzy.ts` is fed that set. Executed in the link-family PR. Noted future-but-out-of-scope:
  unifying scaffold into native `create_concept` (a backend refactor, not this effort).

- [17 ADR / final plan assembly](issues/17-adr-assembly.md) — **destination reached.** All 16
  decisions assembled into [`docs/adr/0006-wasm-shared-core-for-frontend-logic.md`](../../docs/adr/0006-wasm-shared-core-for-frontend-logic.md):
  motivating constraint → toolchain/packaging/marshalling/ownership/load/DTO/test/size seam →
  clean-cut-per-PR sequence with per-family disposition + parity/rollback → explicit TS
  deleted-vs-kept list + 7-step executable checklist. The one artifact this plan-only effort
  commits. Frontier is now empty.

## Not yet specified

- The duplication inventory has **landed** (`research/00-twin-inventory.md`) and
  fully graduated into tickets 10–16 — no migration fog remains.
- Residual fog only: the per-file delete list firms up inside the migration tickets
  (10–16). The exported-fn surface is now largely pinned by 03 (mechanism/convention)
  and 04 (`BundleIndex::{new, resolveLink, resolveWikilink, bundleRoot}`); remaining
  signatures live inside the migration tickets, not here.

Inventory: [`research/00-twin-inventory.md`](research/00-twin-inventory.md).

## Out of scope

- Writing/landing the actual wasm code, migrating any module in the real tree,
  deleting any TS file — this effort is plan-only.
- The reverse consolidation (drop Rust, keep TS) — ruled out in prior discussion:
  the backend index, `backlinks` command, and SSR renderer all need native Rust.
- **Server-side Node** — the wasm seam targets the frontend process only. The JWT
  twin ([`14 JWT cross-crate`](issues/14-migrate-jwt-crosscrate.md), `server/jwt.ts` ↔
  `auth.rs`) runs in the SvelteKit `/api` hook (Node) and is out of scope.
