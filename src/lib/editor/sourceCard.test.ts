import { describe, expect, test } from 'bun:test';
import { placeCard } from './sourceCard';

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
