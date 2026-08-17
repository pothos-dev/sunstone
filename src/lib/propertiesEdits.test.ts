// Unit tests for the Properties panel's pure mutation rules (extracted from
// Properties.svelte). Run with `bun test src/lib`. Pins the new-row
// discard-on-empty/duplicate rules, key-commit behavior per Property kind,
// chip add/remove, and scalar/list edits.
import { describe, expect, test } from 'bun:test';
import type { Property } from './frontmatter';
import {
  addChipAt,
  appendProperty,
  commitKeyEdit,
  removeChipAt,
  removePropertyAt,
  setListAt,
  setScalarAt,
} from './propertiesEdits';

const base = (): Property[] => [
  { key: 'type', kind: 'scalar', scalar: 'note' },
  { key: 'tags', kind: 'list', list: ['a', 'b'] },
  { key: 'meta', kind: 'complex', raw: 'x: 1', entry: 'meta:\n  x: 1\n' },
];

describe('appendProperty', () => {
  test('appends without mutating the input', () => {
    const props = base();
    const next = appendProperty(props, { key: '', kind: 'scalar', scalar: '' });
    expect(next.length).toBe(4);
    expect(props.length).toBe(3);
    expect(next[3]).toEqual({ key: '', kind: 'scalar', scalar: '' });
  });
});

describe('commitKeyEdit (new row)', () => {
  test('empty key discards the row', () => {
    const props = appendProperty(base(), { key: '', kind: 'scalar', scalar: '' });
    const next = commitKeyEdit(props, 3, '', true);
    expect(next).toEqual(base());
  });

  test('whitespace-only key discards the row', () => {
    const props = appendProperty(base(), { key: '', kind: 'scalar', scalar: '' });
    expect(commitKeyEdit(props, 3, '   ', true)).toEqual(base());
  });

  test('duplicate key discards the row', () => {
    const props = appendProperty(base(), { key: '', kind: 'list', list: [] });
    expect(commitKeyEdit(props, 3, 'tags', true)).toEqual(base());
  });

  test('valid key commits (trimmed)', () => {
    const props = appendProperty(base(), { key: '', kind: 'scalar', scalar: '' });
    const next = commitKeyEdit(props, 3, '  status ', true);
    expect(next?.[3]).toEqual({ key: 'status', kind: 'scalar', scalar: '' });
  });
});

describe('commitKeyEdit (existing row)', () => {
  test('empty key reverts (null)', () => {
    expect(commitKeyEdit(base(), 0, '', false)).toBeNull();
  });

  test('unchanged key is a no-op (null)', () => {
    expect(commitKeyEdit(base(), 0, 'type', false)).toBeNull();
  });

  test('undefined draft (live key) is a no-op (null)', () => {
    expect(commitKeyEdit(base(), 0, undefined, false)).toBeNull();
  });

  test('duplicate key reverts (null)', () => {
    expect(commitKeyEdit(base(), 0, 'tags', false)).toBeNull();
  });

  test('missing row is a no-op (null)', () => {
    expect(commitKeyEdit(base(), 9, 'x', false)).toBeNull();
  });

  test('renames a scalar property', () => {
    const next = commitKeyEdit(base(), 0, 'kind', false);
    expect(next?.[0]).toEqual({ key: 'kind', kind: 'scalar', scalar: 'note' });
    expect(next?.[1]).toEqual(base()[1]);
  });

  test('renames a list property', () => {
    const next = commitKeyEdit(base(), 1, 'topics', false);
    expect(next?.[1]).toEqual({ key: 'topics', kind: 'list', list: ['a', 'b'] });
  });

  test('renames a complex property, rewriting its entry key', () => {
    const next = commitKeyEdit(base(), 2, 'extra', false);
    expect(next?.[2].key).toBe('extra');
    expect(next?.[2].entry).toBe('extra:\n  x: 1\n');
    expect(next?.[2].raw).toBe('x: 1');
  });
});

describe('scalar / list edits', () => {
  test('setScalarAt replaces only the target row value', () => {
    const next = setScalarAt(base(), 0, 'task');
    expect(next[0]).toEqual({ key: 'type', kind: 'scalar', scalar: 'task' });
    expect(next[1]).toEqual(base()[1]);
  });

  test('setListAt replaces the target list', () => {
    const next = setListAt(base(), 1, ['z']);
    expect(next[1]).toEqual({ key: 'tags', kind: 'list', list: ['z'] });
  });
});

describe('chips', () => {
  test('addChipAt appends the trimmed draft', () => {
    const next = addChipAt(base(), 1, ['a', 'b'], '  c ');
    expect(next?.[1].list).toEqual(['a', 'b', 'c']);
  });

  test('addChipAt returns null for an empty/whitespace draft', () => {
    expect(addChipAt(base(), 1, ['a'], '')).toBeNull();
    expect(addChipAt(base(), 1, ['a'], '   ')).toBeNull();
  });

  test('removeChipAt removes by index without mutating current', () => {
    const current = ['a', 'b'];
    const next = removeChipAt(base(), 1, current, 0);
    expect(next[1].list).toEqual(['b']);
    expect(current).toEqual(['a', 'b']);
  });
});

describe('removePropertyAt', () => {
  test('removes the row at the index', () => {
    const next = removePropertyAt(base(), 1);
    expect(next.map((p) => p.key)).toEqual(['type', 'meta']);
  });
});
