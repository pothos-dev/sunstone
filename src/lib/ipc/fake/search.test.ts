import { afterEach, describe, expect, test } from 'bun:test';
import { MAX_SEARCH_RESULTS, searchFiles } from './search';
import { FILES } from './store';

// Some tests add files to the shared fixture; restore it after each test.
const filesSnapshot = { ...FILES };

afterEach(() => {
  for (const key of Object.keys(FILES)) if (!(key in filesSnapshot)) delete FILES[key];
  for (const [key, value] of Object.entries(filesSnapshot)) FILES[key] = value;
});

describe('searchFiles', () => {
  test('an empty or whitespace-only query yields no matches', () => {
    expect(searchFiles('')).toEqual([]);
    expect(searchFiles('   ')).toEqual([]);
    expect(searchFiles('\t\n')).toEqual([]);
  });

  test('matches are case-insensitive substrings with 1-based line numbers', () => {
    const hits = searchFiles('MARMALADE');
    expect(hits).toEqual([
      {
        path: 'concepts/bundle.md',
        line: 13,
        snippet:
          'A second mention of Marmalade lives here to prove cross-Concept full-text search.',
      },
      {
        path: 'concepts/codemirror.md',
        line: 13,
        snippet: 'The distinctive word marmalade appears here so full-text search has a target.',
      },
    ]);
  });

  test('hits are ordered by path then line', () => {
    const hits = searchFiles('pomegranate');
    expect(hits.length).toBe(30);
    expect(hits.every((h) => h.path === 'concepts/search-overflow.md')).toBe(true);
    expect(hits.map((h) => h.line)).toEqual([...hits.map((h) => h.line)].sort((a, b) => a - b));
  });

  test('results are capped at MAX_SEARCH_RESULTS', () => {
    expect(MAX_SEARCH_RESULTS).toBe(500);
    FILES['zzz-overflow.md'] = Array.from(
      { length: MAX_SEARCH_RESULTS + 100 },
      (_, i) => `quixotic filler line ${i + 1}`,
    ).join('\n');
    const hits = searchFiles('quixotic');
    expect(hits.length).toBe(MAX_SEARCH_RESULTS);
    // The cap truncates the scan: the first MAX_SEARCH_RESULTS matches survive,
    // still sorted by path then line.
    expect(hits[0]).toEqual({ path: 'zzz-overflow.md', line: 1, snippet: 'quixotic filler line 1' });
    expect(hits[hits.length - 1].line).toBe(MAX_SEARCH_RESULTS);
  });

  test('the cap applies across files in path order (earlier paths win)', () => {
    FILES['aaa-first.md'] = 'quixotic early line';
    FILES['zzz-overflow.md'] = Array.from(
      { length: MAX_SEARCH_RESULTS + 100 },
      (_, i) => `quixotic filler line ${i + 1}`,
    ).join('\n');
    const hits = searchFiles('quixotic');
    expect(hits.length).toBe(MAX_SEARCH_RESULTS);
    expect(hits[0]).toEqual({ path: 'aaa-first.md', line: 1, snippet: 'quixotic early line' });
    expect(hits[hits.length - 1]).toEqual({
      path: 'zzz-overflow.md',
      line: MAX_SEARCH_RESULTS - 1,
      snippet: `quixotic filler line ${MAX_SEARCH_RESULTS - 1}`,
    });
  });
});
