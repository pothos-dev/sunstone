---
type: Reference
title: Testing Sunstone
description: The four green gates plus the two Playwright suites, and which package owns which test.
tags: [testing, playwright, cargo, gates, ci]
timestamp: 2026-07-23T00:00:00Z
---

# Testing Sunstone

Sunstone has **four green gates** plus **two Playwright suites**. Every change must keep the gates green; behavioural changes to components are proven in Playwright.

The gates and suites map onto the [package architecture](/architecture/index.md): `cargo test` / `cargo check` cover the Rust crates ([sunstone-shared](/architecture/sunstone-shared.md), [sunstone-native](/architecture/sunstone-native.md), `sunstone-wasm`, [sunstone-server](/architecture/sunstone-server.md), [desktop shell](/architecture/desktop-shell.md)); `bun test src/lib` and `bun run check` cover the [web frontend](/architecture/web-frontend.md)'s pure logic and types; the two Playwright suites exercise the assembled desktop and web stacks end-to-end. `cargo test` is the single behavioural gate for the pure `sunstone-shared` algorithms — there is no TS twin to mirror them ([ADR 0006](/adr/0006-wasm-shared-core-for-frontend-logic.md)).

| What | Command | Proves |
| --- | --- | --- |
| Frontend unit | `bun test src/lib` | Pure `src/lib/**/*.test.ts` logic |
| Frontend typecheck | `bun run check` | `svelte-check` over the whole frontend |
| Rust unit | `cargo test` | `#[cfg(test)]` across the workspace |
| Rust typecheck | `cargo check` | Whole Cargo workspace compiles |

## Frontend unit tests — `bun test src/lib`

Runs the pure-logic modules (the repo convention: **pure logic lives in plain `.ts`**; `.svelte`/`.svelte.ts` stay thin over it, so the substance is unit-testable). Tests sit beside their module as `*.test.ts`.

```bash
bun test src/lib                       # all frontend unit tests
bun test src/lib/ipc/http.test.ts      # a single file
```

This covers, among others: path/tree helpers and the `frontmatter.ts` property model, the `fake` backend's own modules (`src/lib/ipc/fake/*.test.ts`), `http.ts` SSE-payload parsing (`src/lib/ipc/http.test.ts`), and the **wasm seam** — the JS↔wasm marshalling contract and `BundleIndex` `.free()` lifecycle, byte-loading the shipping `--target web` `pkg/` (tested = shipped, [ADR 0006](/adr/0006-wasm-shared-core-for-frontend-logic.md) §7). The pure algorithms themselves are *not* re-tested here — their goldens are `cargo test`.

### Build the wasm before the frontend gates

`bun test src/lib` and `bun run check` need `src/lib/wasm/pkg` on disk. Build it first (or run the `:ci` scripts that chain it in):

```bash
bun run build:wasm     # wasm-pack build --target web → src/lib/wasm/pkg (gitignored)
bun run build:frontend # build:wasm + build:types
bun run check:ci       # build:frontend, then check
bun run test:unit:ci   # build:frontend, then bun test src/lib
```

## Rust tests — `cargo test`

The Rust side is a **Cargo workspace** with five members — `crates/sunstone-shared`, `crates/sunstone-native`, `crates/sunstone-wasm`, `crates/sunstone-server`, and `src-tauri`. Run from the repo root:

```bash
cargo test                         # every crate
cargo test -p sunstone-shared      # the pure algorithm goldens (link/frontmatter/outline/…)
cargo test -p sunstone-native      # native IO/index (bundle/rewrite/git primitives)
cargo test -p sunstone-server      # the axum server (routes, orchestration, auth)
cargo check                        # typecheck only — includes the wasm crate's native compile
```

`cargo test -p sunstone-shared` is the behavioural gate for the pure algorithms the browser runs via wasm; `cargo check` compiles `sunstone-wasm` on the native host (proving the toolchain, since its exports are inert off `wasm32`). Git-touching code (`crates/sunstone-native/src/git.rs`) is tested against a **temporary git repo** created in the test — assert on real `git log` / `git show` output, no fixtures on disk.

## Playwright — two suites

Playwright is the primary **behavioural** test for components. There are two runners, and they are **disjoint** (each spec belongs to exactly one):

### 1. Desktop suite — `playwright.config.ts`

The static SPA (`bun run build && bun run preview`) + the in-memory **`fake` backend** on port 1420. This is the default runner and covers the desktop editor and all shared components. It `testIgnore`s the web specs.

```bash
bunx playwright test -c playwright.local.config.ts             # all desktop specs
bunx playwright test -c playwright.local.config.ts tree-crud   # a subset (by spec name)
```

`playwright.local.config.ts` is a sandbox override: this machine has a system Chromium at `/tmp/chromium` (no ms-playwright cache), and the override points the launcher at it and runs `--no-sandbox`. On a normal machine use `playwright.config.ts` directly. Override the binary with `CHROMIUM_BIN=/path/to/chromium`.

### 2. Web e2e suite — `playwright.web.config.ts`

The **real** stack end-to-end: it boots the `sunstone-server` Rust binary over the committed fixture Bundle `tests/fixtures/web-bundle`, plus the real adapter-node SSR build (`SUNSTONE_TARGET=web`) proxying `/api` to it. This is the only place the web chrome (`web-viewer`, the editor island, concurrency modals) renders, so all **web** behaviour is proven here.

```bash
bunx playwright test -c playwright.web.config.ts
```

In a resource-constrained sandbox, launching a second Chromium alongside the two servers can OOM. Connect to an already-running Chromium over CDP instead:

```bash
PW_CDP=http://localhost:9222 bunx playwright test -c playwright.web.config.ts
```

`reuseExistingServer` also lets you pre-build/pre-start either server by hand (e.g. build to a temp dir where in-repo build dirs are protected) and have Playwright reuse it.

## Web write testing strategy

The web write path is tested **by the seam**: the frontend never observes a commit (write methods return `204`/`RewriteSummary`), so the pieces are proven where they are actually observable. See `.scratch/enable-web-writing/issues/09-web-write-test-strategy.md` for the full decision.

- **The `fake` backend models no commit creation.** Web writes just mutate the in-memory Bundle and fire a `FileChange`; committing is a server-only concern the fake ignores.
- **`cargo test` owns the substance below the seam:** the `git::commit` primitive + amend-else-fresh (temp repo, assert real `git log`), server write-route orchestration + the global write lock, the write error classifier (400/404/409/500), and the `AuthedUser` JWT extractor.
- **`bun test src/lib` owns client decision logic** extracted to plain `.ts`: the file-change path-match routing, the clean→reload vs dirty→modal branching, the three-way leave/structural-op decision, the per-tab `clientId` echo filter, and `http.ts` write request shaping / error mapping.
- **The web e2e suite owns the rendered end-to-end path:** a test-authed user Saves → a real commit lands in the fixture repo; a second client's edit drives the concurrency modals over real SSE. New specs live in their own `web-*.spec.ts` files.

### Auth in tests

- **Rust:** the extractor verifies an HS256 JWT against a shared-secret env var, so tests **mint a JWT with the test secret** and set `Authorization: Bearer …` directly — no OIDC, no Auth.js. Valid → 200; missing/expired/tampered → 401.
- **Web e2e:** a **test-only, env-gated Auth.js Credentials provider** (enabled only under a test flag, off in every real build) gives a fixed identity. Playwright logs in through the real sign-in flow, exercising the whole session → hook JWT-mint → axum verify chain. Unauthed state is reached by simply not logging in. The real OIDC/Dex provider wiring is a deployment concern, out of scope for the test suites.
