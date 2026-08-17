import type { BundleState } from '$lib/types';

/**
 * Shared persisted-BundleState plumbing for the localStorage-backed backends
 * (fake + http). Both persist per-Bundle View state as JSON under a
 * backend-specific key; loading spreads the parsed JSON over the defaults so
 * fields later added to `BundleState` survive a reload without either loader
 * having to enumerate them (see `bundleState.test.ts`).
 */

/** Fresh-Bundle default (mirrors the Rust `BundleState::default`). */
export function defaultBundleState(): BundleState {
  return { lastOpenConcept: null, expandedFolders: [], recentFiles: [] };
}

/**
 * Load persisted Bundle View state from `localStorage` under `key`. Returns
 * the fresh default on the server (SSR: no `localStorage`), a missing key, or
 * corrupt JSON — never rejects. Optional fields pass through untouched (the
 * session store defaults each on read).
 */
export function loadBundleState(key: string): BundleState {
  if (typeof localStorage === 'undefined') return defaultBundleState();
  const raw = localStorage.getItem(key);
  if (raw === null) return defaultBundleState();
  try {
    const parsed = JSON.parse(raw) as Partial<BundleState>;
    return {
      ...parsed,
      lastOpenConcept: parsed.lastOpenConcept ?? null,
      expandedFolders: Array.isArray(parsed.expandedFolders) ? parsed.expandedFolders : [],
      recentFiles: Array.isArray(parsed.recentFiles) ? parsed.recentFiles : [],
    };
  } catch {
    return defaultBundleState();
  }
}

/** Persist Bundle View state to `localStorage` under `key`. A no-op on the
 * server or if storage is full/disabled (best-effort — never throws into the
 * UI). */
export function saveBundleState(key: string, state: BundleState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* storage full / disabled — best-effort, never throw */
  }
}
