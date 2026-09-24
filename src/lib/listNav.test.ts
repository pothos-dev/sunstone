import { describe, expect, test } from 'bun:test';
import { clampIndex, listKeyIntent, nextIndex, prevIndex, stepIndex } from './listNav';

describe('clampIndex', () => {
  test('returns 0 for an empty list', () => {
    expect(clampIndex(0, 0)).toBe(0);
    expect(clampIndex(5, 0)).toBe(0);
  });

  test('passes through an in-range index', () => {
    expect(clampIndex(2, 5)).toBe(2);
    expect(clampIndex(0, 5)).toBe(0);
  });

  test('clamps a too-large index to the last item', () => {
    expect(clampIndex(9, 3)).toBe(2);
    expect(clampIndex(3, 3)).toBe(2);
  });
});

describe('nextIndex', () => {
  test('advances by one', () => {
    expect(nextIndex(0, 4)).toBe(1);
    expect(nextIndex(2, 4)).toBe(3);
  });

  test('wraps from the last item to the first', () => {
    expect(nextIndex(3, 4)).toBe(0);
  });

  test('returns 0 for an empty list', () => {
    expect(nextIndex(0, 0)).toBe(0);
  });
});

describe('prevIndex', () => {
  test('steps back by one', () => {
    expect(prevIndex(2, 4)).toBe(1);
    expect(prevIndex(1, 4)).toBe(0);
  });

  test('wraps from the first item to the last', () => {
    expect(prevIndex(0, 4)).toBe(3);
  });

  test('returns 0 for an empty list', () => {
    expect(prevIndex(0, 0)).toBe(0);
  });
});

describe('listKeyIntent', () => {
  test('maps the shared palette keys', () => {
    expect(listKeyIntent({ key: 'ArrowDown' })).toBe('next');
    expect(listKeyIntent({ key: 'ArrowUp' })).toBe('prev');
    expect(listKeyIntent({ key: 'Enter' })).toBe('enter');
  });

  test('leaves every other key (Escape, letters, Tab) to the caller', () => {
    for (const key of ['Escape', 'j', 'k', 'Tab', 'Home', 'a']) {
      expect(listKeyIntent({ key })).toBeNull();
    }
  });
});

describe('stepIndex', () => {
  test('wraps in both directions', () => {
    expect(stepIndex('next', 2, 3)).toBe(0);
    expect(stepIndex('prev', 0, 3)).toBe(2);
    expect(stepIndex('next', 0, 0)).toBe(0);
  });
});
