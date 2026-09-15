import { describe, expect, test } from 'bun:test';
import { highlightParts, highlightPositions } from './highlight';

describe('highlightParts', () => {
  test('empty query yields a single unmatched run', () => {
    expect(highlightParts('hello world', '')).toEqual([
      { text: 'hello world', match: false },
    ]);
    expect(highlightParts('hello', '   ')).toEqual([{ text: 'hello', match: false }]);
  });

  test('splits around a single match, preserving original casing', () => {
    expect(highlightParts('Hello World', 'world')).toEqual([
      { text: 'Hello ', match: false },
      { text: 'World', match: true },
    ]);
  });

  test('emphasises every occurrence', () => {
    expect(highlightParts('aXaXa', 'x')).toEqual([
      { text: 'a', match: false },
      { text: 'X', match: true },
      { text: 'a', match: false },
      { text: 'X', match: true },
      { text: 'a', match: false },
    ]);
  });

  test('a match at the very start has no leading unmatched run', () => {
    expect(highlightParts('match here', 'match')).toEqual([
      { text: 'match', match: true },
      { text: ' here', match: false },
    ]);
  });

  test('no match yields the whole snippet unmatched', () => {
    expect(highlightParts('nothing', 'zzz')).toEqual([
      { text: 'nothing', match: false },
    ]);
  });
});

describe('highlightPositions', () => {
  test('returns one unmatched run when nothing matched', () => {
    expect(highlightPositions('/a/b', [])).toEqual([{ text: '/a/b', match: false }]);
  });

  test('splits into alternating unmatched and matched runs', () => {
    expect(highlightPositions('abcd', [1, 2])).toEqual([
      { text: 'a', match: false },
      { text: 'bc', match: true },
      { text: 'd', match: false },
    ]);
  });

  test('handles a hit at the first and last character', () => {
    expect(highlightPositions('abc', [0, 2])).toEqual([
      { text: 'a', match: true },
      { text: 'b', match: false },
      { text: 'c', match: true },
    ]);
  });

  test('ignores out-of-range positions', () => {
    expect(highlightPositions('ab', [-1, 5])).toEqual([{ text: 'ab', match: false }]);
  });

  test('a fully matched string is a single matched run', () => {
    expect(highlightPositions('ab', [0, 1])).toEqual([{ text: 'ab', match: true }]);
  });

  test('empty text yields no runs', () => {
    expect(highlightPositions('', [])).toEqual([]);
  });
});
