import { describe, expect, test } from 'bun:test';
import { dragFraction } from './dividerDrag';

// `startDividerDrag` itself is DOM pointer-capture plumbing (window listeners,
// setPointerCapture) and is exercised by the Playwright divider-drag specs;
// only the pure delta math is unit-tested here.
describe('dragFraction', () => {
  test('returns pointer travel as a fraction of the container size', () => {
    expect(dragFraction(100, 150, 500)).toBeCloseTo(0.1);
    expect(dragFraction(100, 100, 500)).toBe(0);
  });

  test('is negative when dragging back past the start', () => {
    expect(dragFraction(200, 100, 400)).toBeCloseTo(-0.25);
  });

  test('clamps a zero/degenerate container size to 1 (no divide-by-zero)', () => {
    expect(dragFraction(0, 3, 0)).toBe(3);
    expect(dragFraction(0, 3, 0.5)).toBe(3);
    expect(dragFraction(0, 3, -10)).toBe(3);
  });
});
