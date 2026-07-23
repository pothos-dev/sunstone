/**
 * `bun test` preload: byte-load the SHIPPING wasm `pkg/` and register it for the
 * synchronous free-export wrappers (ADR 0006 §7 — the ~3-line Node shim, so the
 * unit suites exercise the *shipped* wasm, not a TS twin).
 *
 * The pure frontmatter kernels (`splitFrontmatter`, `parseFrontmatter*`, …)
 * migrated to wasm in family 11, but the KEPT TS-only unit tests still exercise
 * them synchronously — the property-model round-trip (`frontmatter.test.ts`),
 * the outline scan (`outline.test.ts`), and the fake backend (`crud`/`render`
 * specs). In `bun` there is no browser `fetch`/`init()`, so we instantiate the
 * `--target web` module synchronously (`initSync` over the raw `.wasm` bytes)
 * once, up front, and hand it to `setWasmModule` — the same registry the browser
 * loader populates. Requires `build:wasm` to have run first (the gate order).
 *
 * Wired via `bunfig.toml` `[test] preload`. Runs before every unit test file.
 */

import { readFileSync } from 'node:fs';

import * as wasm from '$lib/wasm/pkg';
import { setWasmModule } from '$lib/wasm/exports';

// `bun test` runs from the project root; the pkg is the gitignored build output.
wasm.initSync({ module: readFileSync('src/lib/wasm/pkg/sunstone_wasm_bg.wasm') });
setWasmModule(wasm);
