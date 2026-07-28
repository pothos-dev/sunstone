import { describe, expect, test } from 'bun:test';
import { activeHeadingIndex } from './outlineActive';

describe('activeHeadingIndex', () => {
  test('returns -1 when there are no headings', () => {
    expect(activeHeadingIndex([], 12)).toBe(-1);
  });

  test('returns -1 while the probe sits above the first heading', () => {
    expect(activeHeadingIndex([10, 20, 30], 9)).toBe(-1);
  });

  test('activates a heading the moment it reaches the probe', () => {
    expect(activeHeadingIndex([10, 20, 30], 10)).toBe(0);
    expect(activeHeadingIndex([10, 20, 30], 20)).toBe(1);
  });

  test('keeps the last passed heading active while reading its body', () => {
    expect(activeHeadingIndex([10, 20, 30], 15)).toBe(0);
    expect(activeHeadingIndex([10, 20, 30], 29)).toBe(1);
  });

  test('sticks to the final heading past the end of the document', () => {
    expect(activeHeadingIndex([10, 20, 30], 999)).toBe(2);
  });

  test('handles a single heading', () => {
    expect(activeHeadingIndex([3], 1)).toBe(-1);
    expect(activeHeadingIndex([3], 3)).toBe(0);
  });
});
