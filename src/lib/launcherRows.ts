// Pure row building for the launcher's folder list (slice: launcher-filter).
//
// The launcher shows one line per previously-opened folder — its full path —
// under an auto-focused filter box. Typing fuzzy-matches the PATH (so both the
// folder name and any directory above it are searchable); an empty query keeps
// the backend's recency order untouched. Matched character positions travel
// with each row so the UI can highlight them.
//
// Kept free of DOM/IPC so `Launcher.svelte` stays a thin shell over it; the
// positions feed `highlightPositions` (`highlight.ts`) for rendering.

import { fuzzyMatch } from '$lib/fuzzy';
import type { KnownBundle } from '$lib/types';

/** One launcher line: a known folder plus the query hits inside its path. */
export type LauncherRow = {
  bundle: KnownBundle;
  /** indices into `bundle.path` of the matched query chars (empty when unfiltered) */
  positions: number[];
};

/**
 * Build the visible rows: with an empty query the folders verbatim (the backend
 * already orders them most-recently-opened first), otherwise only the fuzzy
 * matches, best score first. Ties break like `fuzzyRank`: shorter path, then
 * alphabetical, so the order is stable across renders.
 */
export function launcherRows(query: string, bundles: KnownBundle[]): LauncherRow[] {
  const q = query.trim();
  if (q === '') return bundles.map((bundle) => ({ bundle, positions: [] }));

  const scored: { row: LauncherRow; score: number }[] = [];
  for (const bundle of bundles) {
    const m = fuzzyMatch(q, bundle.path);
    if (m !== null) scored.push({ row: { bundle, positions: m.positions }, score: m.score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const [x, y] = [a.row.bundle.path, b.row.bundle.path];
    if (x.length !== y.length) return x.length - y.length;
    return x.localeCompare(y);
  });
  return scored.map((s) => s.row);
}
