import { backend } from '$lib/ipc';
import { findBundleRoot } from '$lib/links';
import { ensureWasm, type BundleIndex } from '$lib/wasm';

/**
 * Frontend mirror of the Rust Bundle index's existence set.
 *
 * CodeMirror decorations are SYNCHRONOUS — the broken-link decoration cannot
 * await a per-link `conceptExists` call while building decorations. So we hold a
 * synchronous `Set` of existing Concept paths here, seeded once from
 * `listConceptPaths()` and refreshed whenever the filesystem changes (the
 * watcher's `file-changed` event) so the styling stays fresh as Concepts are
 * created/removed. The decoration checks membership synchronously via `exists`.
 *
 * Rune-backed so consumers (and a CodeMirror refresh trigger) react to changes.
 */
class IndexStore {
  /** Existing Concept paths (bundle-relative). The decoration reads this set. */
  paths = $state<Set<string>>(new Set());
  /**
   * Bumps on every refresh. A monotonically increasing version that the editor
   * layer subscribes to so it can re-run the (otherwise synchronous) broken-link
   * decoration when the index changes, without diffing the set itself.
   */
  version = $state<number>(0);

  /** Synchronous existence check used by the broken-link decoration. */
  exists(path: string): boolean {
    return this.paths.has(path);
  }

  /** Memoized `findBundleRoot` result, keyed on the current path-set identity. */
  #rootCache: { key: Set<string>; value: string } | null = null;

  /**
   * The wasm `BundleIndex` handle (ADR 0006 §4). Step 0 ships the DUMMY handle
   * with no real set, so it is constructed + `.free()`d alongside the TS path
   * purely to prove the init/load/free lifecycle stands up in the real app;
   * family 10 makes it the actual resolution engine and retires the TS set. It
   * is `null` on SSR or when the wasm load degrades (§5) — the TS path carries
   * on regardless.
   */
  #handle: BundleIndex | null = null;

  /**
   * Best-effort OKF bundle root within the opened tree (`''` = the opened
   * folder itself; see `findBundleRoot`). Bundle-absolute links resolve from
   * this prefix. Recomputed only when the path set is replaced (on `refresh`),
   * since `paths` is swapped wholesale rather than mutated in place.
   */
  bundleRoot(): string {
    if (this.#rootCache?.key !== this.paths) {
      this.#rootCache = { key: this.paths, value: findBundleRoot([...this.paths]) };
    }
    return this.#rootCache.value;
  }

  /**
   * The full list of existing Concept paths (bundle-relative). The wikilink
   * resolver (name-based, ADR-0004) needs the whole candidate set, not just a
   * membership test — it matches a `[[name]]` by basename/suffix across every
   * concept path. Synchronous, backed by the same cached set `exists` reads.
   */
  pathList(): string[] {
    return [...this.paths];
  }

  /** (Re)load the existing-path set from the backend index. */
  async refresh(): Promise<void> {
    // Ensure the wasm module is initialized before building state (ADR 0006
    // §5). Idempotent + memoized; returns `null` on SSR / load failure, in
    // which case we simply skip the handle and run the TS path (silent degrade).
    const wasm = await ensureWasm();
    try {
      const paths = await backend.listConceptPaths();
      // Swap the handle: free the OLD one before building the new (ADR 0006
      // §4). Done only once we have a fresh set to swap in, so a backend error
      // leaves both the previous set AND the previous handle untouched.
      this.#handle?.free();
      this.#handle = wasm ? new wasm.BundleIndex(findBundleRoot(paths)) : null;
      this.paths = new Set(paths);
      this.version += 1;
    } catch {
      // Index unavailable: leave the previous set in place. Broken-link styling
      // is best-effort and must never block; a stale set just means a link may
      // briefly look (un)broken until the next refresh.
    }
  }
}

export const indexStore = new IndexStore();
