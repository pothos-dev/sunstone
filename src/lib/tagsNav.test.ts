import { describe, expect, test } from 'bun:test';
import type { TagCount } from './types';
import { flattenTagRows, indexOfKey, pruneToLiveTags, rowKey, tagKeyIntent } from './tagsNav';

describe('pruneToLiveTags', () => {
  const cache = new Map([
    ['okf', ['a.md']],
    ['gone', ['b.md']],
  ]);

  test('drops vanished tags from both the expanded set and the cache', () => {
    const r = pruneToLiveTags(new Set(['okf', 'editor']), new Set(['okf', 'gone']), cache);
    expect(r.expanded).toEqual(new Set(['okf']));
    expect(r.cache).toEqual(new Map([['okf', ['a.md']]]));
  });

  test('returns null for a field with nothing to prune', () => {
    const r = pruneToLiveTags(new Set(['okf', 'gone']), new Set(['okf']), cache);
    expect(r).toEqual({ expanded: null, cache: null });
  });

  test('prunes each field independently', () => {
    const r = pruneToLiveTags(new Set(['okf']), new Set(['okf']), cache);
    expect(r.expanded).toBeNull();
    expect(r.cache).toEqual(new Map([['okf', ['a.md']]]));
  });

  test('empty live set empties both; inputs are not mutated', () => {
    const expanded = new Set(['okf']);
    const r = pruneToLiveTags(new Set(), expanded, cache);
    expect(r.expanded).toEqual(new Set());
    expect(r.cache).toEqual(new Map());
    expect(expanded).toEqual(new Set(['okf']));
    expect(cache.size).toBe(2);
  });
});

const tags: TagCount[] = [
  { tag: 'okf', count: 3 },
  { tag: 'editor', count: 2 },
  { tag: 'links', count: 1 },
];

const conceptsByTag: Record<string, string[]> = {
  okf: ['concepts/bundle.md', 'concepts/spec.md', 'concepts/format.md'],
  editor: ['concepts/codemirror.md', 'concepts/editor/live-preview.md'],
  links: ['concepts/links.md'],
};
const conceptsOf = (tag: string) => conceptsByTag[tag] ?? [];

describe('rowKey', () => {
  test('keys a tag root by its tag', () => {
    expect(rowKey('okf', null)).toBe('okf');
  });
  test('keys a concept leaf by tag + path, so the same Concept under two tags is distinct', () => {
    expect(rowKey('okf', 'concepts/bundle.md')).not.toBe(
      rowKey('editor', 'concepts/bundle.md'),
    );
  });
});

describe('flattenTagRows', () => {
  test('with nothing expanded, rows are just the tag roots', () => {
    const rows = flattenTagRows(tags, () => false, conceptsOf);
    expect(rows.map((r) => r.key)).toEqual(['okf', 'editor', 'links']);
    expect(rows.every((r) => r.isTag)).toBe(true);
    expect(rows.every((r) => !r.expanded)).toBe(true);
  });

  test('an expanded tag interleaves its concept leaves after its root', () => {
    const expanded = new Set(['editor']);
    const rows = flattenTagRows(tags, (t) => expanded.has(t), conceptsOf);
    expect(rows.map((r) => r.key)).toEqual([
      rowKey('okf', null),
      rowKey('editor', null),
      rowKey('editor', 'concepts/codemirror.md'),
      rowKey('editor', 'concepts/editor/live-preview.md'),
      rowKey('links', null),
    ]);
    const leaf = rows[2];
    expect(leaf.isTag).toBe(false);
    expect(leaf.tag).toBe('editor');
    expect(leaf.path).toBe('concepts/codemirror.md');
  });

  test('MULTIPLE tags expand at once (the multi-expand win)', () => {
    const expanded = new Set(['okf', 'links']);
    const rows = flattenTagRows(tags, (t) => expanded.has(t), conceptsOf);
    expect(rows.map((r) => r.key)).toEqual([
      rowKey('okf', null),
      rowKey('okf', 'concepts/bundle.md'),
      rowKey('okf', 'concepts/spec.md'),
      rowKey('okf', 'concepts/format.md'),
      rowKey('editor', null),
      rowKey('links', null),
      rowKey('links', 'concepts/links.md'),
    ]);
    // The expanded tag roots report expanded=true; the collapsed one false.
    expect(rows.find((r) => r.key === 'okf')?.expanded).toBe(true);
    expect(rows.find((r) => r.key === 'editor')?.expanded).toBe(false);
    expect(rows.find((r) => r.key === 'links')?.expanded).toBe(true);
  });

  test('an expanded tag with an empty (not-yet-loaded) cache yields no leaves', () => {
    const rows = flattenTagRows(tags, (t) => t === 'okf', () => []);
    expect(rows.map((r) => r.key)).toEqual(['okf', 'editor', 'links']);
  });
});

describe('indexOfKey', () => {
  const rows = flattenTagRows(tags, () => true, conceptsOf);
  test('finds an existing row key', () => {
    expect(indexOfKey(rows, 'editor')).toBe(rows.findIndex((r) => r.key === 'editor'));
  });
  test('returns -1 for a missing or null key', () => {
    expect(indexOfKey(rows, 'nope')).toBe(-1);
    expect(indexOfKey(rows, null)).toBe(-1);
  });
});

describe('tagKeyIntent', () => {
  // okf (expanded, leaves a.md + b.md), editor (collapsed)
  const rows = flattenTagRows(
    [
      { tag: 'okf', count: 2 },
      { tag: 'editor', count: 1 },
    ],
    (t) => t === 'okf',
    () => ['a.md', 'b.md'],
  );
  const okf = rowKey('okf', null);

  test('linear movement focuses the target row key', () => {
    expect(tagKeyIntent('j', rows, 0)).toEqual({ focus: rowKey('okf', 'a.md') });
    expect(tagKeyIntent('Home', rows, 2)).toEqual({ focus: okf });
  });

  test('Right: collapsed tag expands, expanded tag enters its first leaf, leaf no-op', () => {
    expect(tagKeyIntent('ArrowRight', rows, 3)).toEqual({ expand: true });
    expect(tagKeyIntent('l', rows, 0)).toEqual({ focus: rowKey('okf', 'a.md') });
    expect(tagKeyIntent('l', rows, 1)).toEqual({});
  });

  test('Left: expanded tag collapses, collapsed tag stays, leaf goes to its tag', () => {
    expect(tagKeyIntent('ArrowLeft', rows, 0)).toEqual({ expand: false });
    expect(tagKeyIntent('h', rows, 3)).toEqual({});
    expect(tagKeyIntent('h', rows, 2)).toEqual({ focus: okf });
  });

  test('Right/Left with nothing focused land on the first row', () => {
    expect(tagKeyIntent('l', rows, -1)).toEqual({ focus: okf });
    expect(tagKeyIntent('h', rows, -1)).toEqual({ focus: okf });
  });

  test('Enter toggles a tag and opens a leaf; Space is not handled', () => {
    expect(tagKeyIntent('Enter', rows, 0)).toEqual({ expand: false });
    expect(tagKeyIntent('Enter', rows, 1)).toEqual({ open: true });
    expect(tagKeyIntent('Enter', rows, -1)).toBeNull();
    expect(tagKeyIntent(' ', rows, 0)).toBeNull();
  });
});
