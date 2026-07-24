import { describe, it, expect } from 'bun:test';
import {
  clampSidebarWidth,
  resizeSidebarWidth,
  isDragGesture,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  DRAG_THRESHOLD_PX,
} from './sidebarResize';

describe('clampSidebarWidth', () => {
  it('passes through a width inside the bounds', () => {
    expect(clampSidebarWidth(300)).toBe(300);
  });

  it('clamps below the minimum up to the minimum', () => {
    expect(clampSidebarWidth(10)).toBe(MIN_SIDEBAR_WIDTH);
  });

  it('clamps above the maximum down to the maximum', () => {
    expect(clampSidebarWidth(9999)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it('honours custom bounds', () => {
    expect(clampSidebarWidth(100, 50, 80)).toBe(80);
    expect(clampSidebarWidth(30, 50, 80)).toBe(50);
  });

  it('falls back to the default for a non-finite width', () => {
    expect(clampSidebarWidth(NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(Infinity)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});

describe('resizeSidebarWidth', () => {
  it('grows the left sidebar when dragging right, shrinks when dragging left', () => {
    expect(resizeSidebarWidth(280, 40, 'left')).toBe(320);
    expect(resizeSidebarWidth(280, -40, 'left')).toBe(240);
  });

  it('grows the right sidebar when dragging left, shrinks when dragging right', () => {
    expect(resizeSidebarWidth(280, -40, 'right')).toBe(320);
    expect(resizeSidebarWidth(280, 40, 'right')).toBe(240);
  });

  it('clamps to the bounds so a drag past a limit stops cleanly', () => {
    expect(resizeSidebarWidth(MAX_SIDEBAR_WIDTH, 500, 'left')).toBe(MAX_SIDEBAR_WIDTH);
    expect(resizeSidebarWidth(MIN_SIDEBAR_WIDTH, -500, 'left')).toBe(MIN_SIDEBAR_WIDTH);
  });

  it('is idempotent from a captured base (reversing recovers)', () => {
    const base = 300;
    expect(resizeSidebarWidth(base, 50, 'left')).toBe(350);
    expect(resizeSidebarWidth(base, 0, 'left')).toBe(base);
    expect(resizeSidebarWidth(base, -50, 'left')).toBe(250);
  });
});

describe('isDragGesture', () => {
  it('is a click below the threshold on both axes', () => {
    expect(isDragGesture(0, 0)).toBe(false);
    expect(isDragGesture(DRAG_THRESHOLD_PX - 1, DRAG_THRESHOLD_PX - 1)).toBe(false);
  });

  it('is a drag at or beyond the threshold on either axis', () => {
    expect(isDragGesture(DRAG_THRESHOLD_PX, 0)).toBe(true);
    expect(isDragGesture(0, DRAG_THRESHOLD_PX)).toBe(true);
    expect(isDragGesture(-100, 0)).toBe(true);
  });
});
