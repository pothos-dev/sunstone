// Match highlighting for the result lists (pure; no DOM/IPC).
//
// Splits a string into alternating matched / unmatched runs so the UI can
// emphasise what the query hit. Two flavours, one shape:
//   - `highlightParts` — every case-insensitive OCCURRENCE of a substring
//     query (full-text Search snippets);
//   - `highlightPositions` — the character INDICES a fuzzy match reported
//     (the launcher's folder paths).
// Kept as pure functions over strings so they are unit-testable independently
// of the SearchPanel / Launcher components.

/** One run of a snippet: `match` is true for the substrings to emphasise. */
export interface HighlightPart {
  text: string;
  match: boolean;
}

/**
 * Split `snippet` around every case-insensitive occurrence of `query`,
 * preserving the snippet's original casing in the returned text. An empty (or
 * whitespace-only) query yields a single unmatched run covering the whole
 * snippet.
 */
export function highlightParts(snippet: string, query: string): HighlightPart[] {
  const q = query.trim();
  if (q === '') return [{ text: snippet, match: false }];
  const lower = snippet.toLowerCase();
  const needle = q.toLowerCase();
  const parts: HighlightPart[] = [];
  let i = 0;
  let found = lower.indexOf(needle, i);
  while (found !== -1) {
    if (found > i) parts.push({ text: snippet.slice(i, found), match: false });
    parts.push({ text: snippet.slice(found, found + needle.length), match: true });
    i = found + needle.length;
    found = lower.indexOf(needle, i);
  }
  if (i < snippet.length) parts.push({ text: snippet.slice(i), match: false });
  return parts;
}

/**
 * Split `text` into alternating unmatched / matched runs at `positions` —
 * character indices, as `fuzzyMatch` reports them. Out-of-range indices are
 * ignored and empty runs are never emitted, so no positions yield a single
 * unmatched run (and an empty `text` yields none at all).
 */
export function highlightPositions(text: string, positions: number[]): HighlightPart[] {
  const hits = new Set(positions.filter((i) => i >= 0 && i < text.length));
  const parts: HighlightPart[] = [];
  let start = 0;
  let match = hits.has(0);
  for (let i = 1; i <= text.length; i++) {
    const next = i < text.length && hits.has(i);
    if (i === text.length || next !== match) {
      if (i > start) parts.push({ text: text.slice(start, i), match });
      start = i;
      match = next;
    }
  }
  return parts;
}
