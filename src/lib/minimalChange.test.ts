import { describe, expect, test } from 'bun:test';
import { minimalChange } from './minimalChange';

describe('minimalChange', () => {
  test('returns null for identical strings', () => {
    expect(minimalChange('abc', 'abc')).toBeNull();
  });

  test('trims common prefix and suffix around a middle edit', () => {
    expect(minimalChange('hello world', 'hello there world')).toEqual({
      from: 6,
      to: 6,
      insert: 'there ',
    });
  });

  test('handles a full replacement with no shared prefix/suffix', () => {
    expect(minimalChange('abc', 'xyz')).toEqual({ from: 0, to: 3, insert: 'xyz' });
  });

  test('handles pure insertion', () => {
    expect(minimalChange('ac', 'abc')).toEqual({ from: 1, to: 1, insert: 'b' });
  });

  test('handles pure deletion', () => {
    expect(minimalChange('abc', 'ac')).toEqual({ from: 1, to: 2, insert: '' });
  });

  test('handles empty strings', () => {
    expect(minimalChange('', 'abc')).toEqual({ from: 0, to: 0, insert: 'abc' });
    expect(minimalChange('abc', '')).toEqual({ from: 0, to: 3, insert: '' });
  });
});
