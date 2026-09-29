# 07 — Test & coverage strategy after twin removal

Type: grilling
Status: resolved
Blocked by: 02, 04

## Question

How is behavioural coverage preserved when the `bun test src/lib` twins are deleted?

Today `bun test src/lib` exercises `links.ts`, `slug.ts`, `frontmatter.ts`,
`citations.ts`, `outline.ts`, etc. as pure TS. After migration the algorithms are
Rust (covered by `cargo test`). Decide:

- Which pure-TS unit tests are retired (logic now Rust-tested) vs re-pointed at the
  wasm module to guard the *binding/marshalling* layer.
- How the Playwright fake backend consumes wasm (see ticket 12) and whether that
  changes the desktop-suite fake vs the real backend contract.
- Whether a thin "wasm parity" harness is worth it, or `cargo test` + Playwright
  suffice. Reconcile with root `AGENTS.md`'s four gates.

## Answer

Guiding principle: the effort's whole point is *single source of truth*, so the
test strategy must not re-create the twin as a **test twin**. Algorithm goldens
live in exactly one place (Rust).

1. **Algorithm correctness → `cargo test`, wholesale.** At each cut-over, delete
   every pure-algorithm TS twin *and its unit test*: `links.test.ts`, `slug.test.ts`,
   `anchorRewrite.test.ts`, `citations.test.ts`, `outline.test.ts`, the
   `frontmatter.ts` parse/split cases, and the `ipc/fake/{links,frontmatter,render}.test.ts`
   re-impl tests. **No golden cases mirrored TS-side** — mirroring is the drift we
   are deleting.

2. **`bun test src/lib` keeps two jobs** (and stays a named gate):
   - **Seam guard** — the JS↔wasm boundary `cargo test` can't see: marshalling
     contract (camelCase `js_name`, internally-tagged `ResolvedLink`, the
     `exists: boolean` fold from 04) via serde-wasm-bindgen/tsify, plus the
     `.free()`-on-swap **lifecycle** from 04.
   - **TS-only pure logic** with no Rust source: `fuzzy`, `highlight`,
     `diff/diffToCriticMarkup`, `editor/textFormat`, `editor/mermaidBlocks`,
     `reserved`, `frontmatter.ts`'s `titleFromFilename`/`scaffoldConcept`, and the
     nav/layout/state helpers.

3. **Seam harness loads the *shipping* artifact.** A ~3-line Node/bun shim
   byte-loads the `--target web` `pkg/` (`await init(readFileSync('src/lib/wasm/pkg/…_bg.wasm'))`)
   — `init` accepts a `BufferSource`, no fetch/Vite needed. **One artifact**: tested
   = shipped; no `--target nodejs` test-only twin. Relies on `build:wasm` already
   ordered before the unit gate (ticket 01).

4. **Playwright division of labour** (no net-new specs — existing decoration /
   broken-link specs carry it; both suites run *real* wasm since it's in-process,
   not behind the IPC seam):
   - **Desktop suite** (real wasm + fake IPC backend) = **primary** behavioural
     guard for the live-unsaved-buffer decoration path — the binding constraint
     that motivates the effort.
   - **Web e2e suite** (real wasm + native Rust + SSR) = **secondary** cross-check
     proving wasm coexists with native Rust without divergence (additive, not
     regressive).

5. **No standing parity harness** (it would resurrect a TS twin to compare against).
   Equivalence-to-TS is a **throwaway cut-over check** owned by each migration
   ticket (10–16): run the deleted twin's goldens through wasm once, confirm
   byte-identical, delete both impl and test.

6. **Four gates unchanged** (`bun test src/lib`, `bun run check`, `cargo test`,
   `cargo check`); Playwright stays the behavioural layer.

**Requirement flagged onto [12](12-migrate-fake-backend-standins.md):** the desktop
suite is only a faithful proxy if `fake.ts`'s index/rewrite ops derive from the
*same shared source* (consume wasm), not a ported divergent TS re-impl. A divergent
fake would silently test different logic than ships and force the parity harness
this ticket rejects. 12 formally decides; this is the coverage constraint it must honour.
