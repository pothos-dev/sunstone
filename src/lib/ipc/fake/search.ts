// The fake backend's full-text search: the JS equivalent of the Rust
// ripgrep-crate search over the in-memory fixture.

import type { SearchHit } from '$lib/types';
import { FILES, conceptPaths } from './store';

/** Mirror of the Rust `MAX_RESULTS` cap (search.rs). */
export const MAX_SEARCH_RESULTS = 500;

/**
 * Full-text search: scan every `.md` Concept's full content for a
 * case-insensitive substring of `query`. Returns one hit per matching line
 * (path + 1-based line + the matching line text), ordered by path then line and
 * capped at MAX_SEARCH_RESULTS to mirror the backend's server-side cap. An
 * empty / whitespace query yields no matches (the UI doesn't search until
 * input).
 */
export function searchFiles(query: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];

  const hits: SearchHit[] = [];
  for (const path of conceptPaths()) {
    const lines = FILES[path].split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, '');
      if (line.toLowerCase().includes(needle)) {
        hits.push({ path, line: i + 1, snippet: line });
        if (hits.length >= MAX_SEARCH_RESULTS) break;
      }
    }
    if (hits.length >= MAX_SEARCH_RESULTS) break;
  }
  hits.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)));
  return hits.slice(0, MAX_SEARCH_RESULTS);
}
