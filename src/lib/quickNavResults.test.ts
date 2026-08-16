// Unit tests for the shared quick-nav result building. Run with
// `bun test src/lib`. Pins the concept+tag mixing/ranking, tag drill-down
// filtering, and the empty-query behavior of BOTH palette variants (desktop:
// recents kept to existing paths; web: all Concept paths).
import { describe, expect, test } from 'bun:test';
import {
  quickNavResults,
  recentKnownPaths,
  type QuickNavInputs,
  type QuickNavResult,
} from './quickNavResults';

const base = (over: Partial<QuickNavInputs> = {}): QuickNavInputs => ({
  query: '',
  tagMode: null,
  tagConcepts: [],
  paths: ['notes/alpha.md', 'notes/beta.md', 'zeta.md'],
  tags: ['alpha', 'beach'],
  emptyQueryPaths: [],
  ...over,
});

const keys = (rs: QuickNavResult[]) =>
  rs.map((r) => (r.kind === 'tag' ? `tag:${r.tag}` : r.path));

describe('empty query', () => {
  test('returns emptyQueryPaths verbatim as concept rows (desktop recents order)', () => {
    const rs = quickNavResults(base({ emptyQueryPaths: ['zeta.md', 'notes/beta.md'] }));
    expect(keys(rs)).toEqual(['zeta.md', 'notes/beta.md']);
    expect(rs.every((r) => r.kind === 'concept')).toBe(true);
  });

  test('whitespace-only query counts as empty', () => {
    const rs = quickNavResults(base({ query: '   ', emptyQueryPaths: ['zeta.md'] }));
    expect(keys(rs)).toEqual(['zeta.md']);
  });

  test('web variant: passing all paths browses everything in order', () => {
    const inputs = base();
    const rs = quickNavResults({ ...inputs, emptyQueryPaths: inputs.paths });
    expect(keys(rs)).toEqual(['notes/alpha.md', 'notes/beta.md', 'zeta.md']);
  });
});

describe('recentKnownPaths (desktop empty-query list)', () => {
  test('keeps recents order, dropping deleted paths', () => {
    expect(
      recentKnownPaths(['gone.md', 'zeta.md', 'notes/alpha.md'], [
        'notes/alpha.md',
        'zeta.md',
      ]),
    ).toEqual(['zeta.md', 'notes/alpha.md']);
  });
});

describe('mixing and ranking', () => {
  test('mixes concept and tag matches, best score first', () => {
    const rs = quickNavResults(base({ query: 'alpha' }));
    // 'alpha' the tag is a full contiguous boundary match on a shorter target
    // than 'notes/alpha.md'; both must appear, tag flagged as such.
    expect(keys(rs)).toEqual(['tag:alpha', 'notes/alpha.md']);
  });

  test('non-matching entries are excluded', () => {
    const rs = quickNavResults(base({ query: 'zeta' }));
    expect(keys(rs)).toEqual(['zeta.md']);
  });

  test('ties break toward the shorter target', () => {
    const rs = quickNavResults(
      base({ paths: ['aa/x.md'], tags: ['x'], query: 'x' }),
    );
    // Identical per-char bonuses would still differ via the length penalty;
    // assert the shorter target ('x') sorts first.
    expect(keys(rs)[0]).toBe('tag:x');
  });

  test('no matches yields an empty list', () => {
    expect(quickNavResults(base({ query: 'qqq' }))).toEqual([]);
  });
});

describe('tag drill-down', () => {
  test('empty query shows the tag concepts verbatim', () => {
    const rs = quickNavResults(
      base({ tagMode: 'alpha', tagConcepts: ['b.md', 'a.md'] }),
    );
    expect(keys(rs)).toEqual(['b.md', 'a.md']);
  });

  test('query fuzzy-filters and ranks the tag concepts, never surfacing tags', () => {
    const rs = quickNavResults(
      base({
        tagMode: 'alpha',
        tagConcepts: ['notes/alpha.md', 'beach.md'],
        query: 'beach',
        tags: ['beach'],
      }),
    );
    expect(keys(rs)).toEqual(['beach.md']);
    expect(rs[0].kind).toBe('concept');
  });

  test('drill-down ignores paths/tags/emptyQueryPaths entirely', () => {
    const rs = quickNavResults(
      base({ tagMode: 't', tagConcepts: [], emptyQueryPaths: ['zeta.md'] }),
    );
    expect(rs).toEqual([]);
  });
});
