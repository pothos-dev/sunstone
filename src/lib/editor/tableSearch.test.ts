import { describe, expect, test } from 'bun:test';
import { SearchQuery } from '@codemirror/search';
import { cellMatches, selectedMatchIndex, tableCellAt } from './tableSearch';

describe('cellMatches', () => {
  test('finds every literal match, case-insensitively by default', () => {
    const q = new SearchQuery({ search: 'ab' });
    expect(cellMatches(q, 'ab xAB ab')).toEqual([
      { from: 0, to: 2 },
      { from: 4, to: 6 },
      { from: 7, to: 9 },
    ]);
  });

  test('honours case-sensitivity and whole-word flags', () => {
    expect(cellMatches(new SearchQuery({ search: 'ab', caseSensitive: true }), 'AB ab')).toEqual([
      { from: 3, to: 5 },
    ]);
    expect(cellMatches(new SearchQuery({ search: 'ab', wholeWord: true }), 'abc ab')).toEqual([
      { from: 4, to: 6 },
    ]);
  });

  test('an empty or invalid query matches nothing', () => {
    expect(cellMatches(new SearchQuery({ search: '' }), 'abc')).toEqual([]);
    expect(cellMatches(new SearchQuery({ search: '(', regexp: true }), 'a(')).toEqual([]);
  });
});

describe('tableCellAt', () => {
  const line = '| one | two \\| x | three |';

  test('maps a column to its cell and offset within the trimmed text', () => {
    expect(tableCellAt(line, 0, 2)).toEqual({ row: 0, col: 0, raw: 'one', offset: 0 });
    expect(tableCellAt(line, 2, 9)).toEqual({ row: 1, col: 1, raw: 'two \\| x', offset: 1 });
    expect(tableCellAt(line, 3, 19)).toEqual({ row: 2, col: 2, raw: 'three', offset: 0 });
  });

  test('works without outer pipes', () => {
    expect(tableCellAt('a | b', 2, 4)).toEqual({ row: 1, col: 1, raw: 'b', offset: 0 });
  });

  test('the delimiter row is not a cell', () => {
    expect(tableCellAt('| --- | --- |', 1, 3)).toBeNull();
  });
});

describe('selectedMatchIndex', () => {
  const q = new SearchQuery({ search: 'o' });

  test('the index of the match the selection covers', () => {
    const pos = { row: 1, col: 0, raw: 'foo bo', offset: 2 };
    expect(selectedMatchIndex(q, pos, 1)).toBe(1);
  });

  test('-1 when the selection is not exactly a match', () => {
    expect(selectedMatchIndex(q, { row: 1, col: 0, raw: 'foo', offset: 0 }, 1)).toBe(-1);
    expect(selectedMatchIndex(q, { row: 1, col: 0, raw: 'foo', offset: 1 }, 2)).toBe(-1);
  });
});
