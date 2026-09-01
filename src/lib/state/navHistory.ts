// Browser-style navigation history (pure; no DOM/IPC/runes).
//
// The per-Tile list of visited Concept paths plus a cursor into it. Opening a
// Concept pushes onto the stack, truncating any forward entries (standard
// browser semantics); Back/Forward move the cursor without re-pushing. Kept as
// a plain, immutable value type so the Tile rune store stays thin over it and
// the index math is unit-testable without a Svelte runtime.

import { remapPath } from '$lib/path';

/** An immutable navigation-history value: the visited paths and the cursor. */
export interface NavHistory {
  /** Visited Concept paths; `entries[index]` is the current Concept. */
  readonly entries: readonly string[];
  /**
   * Remembered scroll offset (px from the top of the editor viewport) per
   * entry, parallel to `entries`. A fresh entry starts at 0 — following a link
   * lands at the top of the new Concept — and is updated as the reader
   * scrolls, so Back/Forward restores where they left off.
   */
  readonly offsets: readonly number[];
  /** Cursor into `entries` (-1 when empty). */
  readonly index: number;
}

/** The empty history (nothing visited yet). */
export const EMPTY_HISTORY: NavHistory = { entries: [], offsets: [], index: -1 };

/** True when there is a previous Concept to go Back to. */
export function canGoBack(h: NavHistory): boolean {
  return h.index > 0;
}

/** True when there is a forward Concept to advance to. */
export function canGoForward(h: NavHistory): boolean {
  return h.index >= 0 && h.index < h.entries.length - 1;
}

/**
 * Push a newly-opened Concept as the current entry, truncating any forward
 * history first (standard browser semantics).
 */
export function pushEntry(h: NavHistory, path: string): NavHistory {
  const entries = [...h.entries.slice(0, h.index + 1), path];
  const offsets = [...h.offsets.slice(0, h.index + 1), 0];
  return { entries, offsets, index: entries.length - 1 };
}

/**
 * Remember `offset` (px) as the current entry's scroll position. No-op on an
 * empty history. Called as the reader scrolls and just before leaving a
 * Concept, so Back/Forward can restore it.
 */
export function setOffset(h: NavHistory, offset: number): NavHistory {
  if (h.index < 0) return h;
  if (h.offsets[h.index] === offset) return h;
  const offsets = [...h.offsets];
  offsets[h.index] = offset;
  return { entries: h.entries, offsets, index: h.index };
}

/** The remembered scroll offset of the current entry (0 when empty). */
export function currentOffset(h: NavHistory): number {
  return h.index < 0 ? 0 : (h.offsets[h.index] ?? 0);
}

/** Move the cursor back one entry, if possible (else unchanged). */
export function goBack(h: NavHistory): NavHistory {
  return canGoBack(h) ? { ...h, index: h.index - 1 } : h;
}

/** Move the cursor forward one entry, if possible (else unchanged). */
export function goForward(h: NavHistory): NavHistory {
  return canGoForward(h) ? { ...h, index: h.index + 1 } : h;
}

/**
 * Rewrite any entries that ARE `from` or sit beneath it (folder rename/move)
 * to the new location, so Back/Forward stay valid across a rename. Returns the
 * rewritten history and whether anything changed.
 */
export function remapHistory(
  h: NavHistory,
  from: string,
  to: string,
): { history: NavHistory; changed: boolean } {
  let changed = false;
  const entries = h.entries.map((p) => {
    const next = remapPath(p, from, to);
    if (next !== null) changed = true;
    return next ?? p;
  });
  return { history: { entries, offsets: h.offsets, index: h.index }, changed };
}
