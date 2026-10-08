import { describe, expect, test } from 'bun:test';
import { placeCard, usageText } from './sourceCard';

const anchor = (left: number, top: number) => ({ left, top, bottom: top + 16, width: 10 });

describe('placeCard', () => {
  test('sits below the anchor, centred', () => {
    expect(placeCard(anchor(500, 100), 200, 80, 1200, 800)).toEqual({ left: 405, top: 122 });
  });

  test('flips above when it does not fit below', () => {
    expect(placeCard(anchor(500, 760), 200, 80, 1200, 800)).toEqual({ left: 405, top: 674 });
  });

  test('stays inside the viewport horizontally', () => {
    expect(placeCard(anchor(2, 100), 200, 80, 1200, 800).left).toBe(8);
    expect(placeCard(anchor(1190, 100), 200, 80, 1200, 800).left).toBe(992);
  });
});

describe('usageText', () => {
  test('frames the count with its window, as written', () => {
    const usageWindow = { from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z' };
    expect(usageText({ usageCount: '5000', usageWindow })).toBe(
      '5000 (2026-06-01T00:00:00Z – 2026-06-30T00:00:00Z)',
    );
  });

  test('an open bound shows as an ellipsis; no window, the bare count', () => {
    expect(usageText({ usageCount: '3', usageWindow: { from: '2026-01-01', to: null } })).toBe(
      '3 (2026-01-01 – …)',
    );
    expect(usageText({ usageCount: '3', usageWindow: null })).toBe('3');
  });

  test('no count, nothing to show (a window alone frames nothing)', () => {
    expect(usageText({ usageCount: null, usageWindow: { from: 'a', to: 'b' } })).toBeNull();
  });
});
