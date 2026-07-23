import { browser } from '$app/environment';

// Type-only imports of the wasm-pack `--target web` output. These erase at
// build time, so importing this loader never drags `pkg/` into the SSR graph —
// the real module only enters via the browser-guarded dynamic `import()` below.
import type { BundleIndex } from '$lib/wasm/pkg';

/** The `BundleIndex` handle class + its generated DTOs (ADR 0006 §3/§6). */
export type { BundleIndex };
export type { ResolvedLink, WikilinkTarget, RewriteBody, AnchorRename } from '$lib/wasm/pkg';

/** The wasm module namespace: `BundleIndex` + the free exports (family 10+). */
type WasmModule = typeof import('$lib/wasm/pkg');

/**
 * The one in-flight (or settled) init promise. Memoized so concurrent
 * `ensureWasm()` callers share a single `import()` + `init()`; reset to `null`
 * on failure so a later call can retry rather than being wedged on a dead page
 * (ADR 0006 §5 "degrades gracefully").
 */
let wasmPromise: Promise<WasmModule | null> | null = null;

async function loadWasm(): Promise<WasmModule | null> {
  // SSR renders native Rust and must never touch wasm (ADR 0006 §1/§5).
  if (!browser) return null;
  try {
    const mod = await import('$lib/wasm/pkg');
    // wasm-pack `--target web`: the default export is the async `init()` that
    // fetches + instantiates the module; exports are usable synchronously after.
    await mod.default();
    return mod;
  } catch (err) {
    // Load/instantiate failed: degrade silently to the TS path. Never throw —
    // a null handle keeps decorations styling as a no-op instead of a dead page.
    console.error('[wasm] init failed; degrading to the TS-only path', err);
    return null;
  }
}

/**
 * Load + `init()` the wasm module exactly once (idempotent, `browser`-guarded).
 * Returns the module namespace, or `null` on SSR / load failure — callers must
 * treat `null` as "run the TS fallback", never as an error.
 */
export function ensureWasm(): Promise<WasmModule | null> {
  if (wasmPromise) return wasmPromise;
  const promise = loadWasm();
  wasmPromise = promise;
  // Allow a retry on the next call if this attempt degraded (null result).
  void promise.then((mod) => {
    if (!mod) wasmPromise = null;
  });
  return promise;
}
