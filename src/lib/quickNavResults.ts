// Pure result-building for the quick-nav palettes (desktop `QuickNav.svelte`
// and web `WebQuickNav.svelte`). Both palettes share the same Result union and
// the same fuzzy concept+tag mixing/ranking; they differ only in the data fed
// in — most visibly the EMPTY-query list (desktop: per-Bundle recents kept to
// existing paths; web: all Concept paths). So this module is parameterized by
// inputs, never by backend.

import { fuzzyRank } from '$lib/fuzzy';

/** One palette row. A tagged Concept renders exactly like a normal Concept. */
export type QuickNavResult = { kind: 'concept'; path: string } | { kind: 'tag'; tag: string };

export interface QuickNavInputs {
  /** The raw input text (trimmed internally). */
  query: string;
  /** Tag drill-down: the active tag, or null for normal search. */
  tagMode: string | null;
  /** The resolved Concept paths carrying the active tag (drill-down list). */
  tagConcepts: string[];
  /** All bundle-relative Concept paths to match against. */
  paths: string[];
  /** All Bundle tags to match against (surfaced alongside Concepts). */
  tags: string[];
  /**
   * Paths shown for an EMPTY query outside drill-down. Desktop passes the
   * recents via `recentKnownPaths`; the web viewer passes all Concept paths.
   */
  emptyQueryPaths: string[];
}

/**
 * The desktop empty-query list: recent files (most-recent first) kept only to
 * existing paths, so a deleted file never lingers.
 */
export function recentKnownPaths(recent: string[], paths: string[]): string[] {
  const known = new Set(paths);
  return recent.filter((p) => known.has(p));
}

/**
 * Build the ordered palette results:
 *   - drill-down (`tagMode` set): the tag's Concepts, fuzzy-filtered by query;
 *   - empty query: `emptyQueryPaths`, verbatim order;
 *   - otherwise: Concept and tag matches mixed, best score first (ties: shorter
 *     target first).
 */
export function quickNavResults(inputs: QuickNavInputs): QuickNavResult[] {
  const { tagMode, tagConcepts, paths, tags, emptyQueryPaths } = inputs;
  const q = inputs.query.trim();

  // Drill-down: the Concepts carrying the active tag, fuzzy-filtered by query.
  if (tagMode !== null) {
    const filtered = q === '' ? tagConcepts : fuzzyRank(q, tagConcepts).map((m) => m.target);
    return filtered.map((path): QuickNavResult => ({ kind: 'concept', path }));
  }

  if (q === '') {
    return emptyQueryPaths.map((path): QuickNavResult => ({ kind: 'concept', path }));
  }

  // Mix Concept and tag matches, best score first (ties: shorter target).
  const scored = [
    ...fuzzyRank(q, paths).map((m) => ({
      r: { kind: 'concept', path: m.target } as QuickNavResult,
      score: m.score,
      len: m.target.length,
    })),
    ...fuzzyRank(q, tags).map((m) => ({
      r: { kind: 'tag', tag: m.target } as QuickNavResult,
      score: m.score,
      len: m.target.length,
    })),
  ];
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.len - b.len));
  return scored.map((s) => s.r);
}
