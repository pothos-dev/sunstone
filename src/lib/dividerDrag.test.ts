import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dragFraction, startDividerDrag, startPointerDrag } from './dividerDrag';

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

// `bun test` has no DOM: stand in a bare EventTarget for `window` and a minimal
// divider element that records pointer capture, so the listener lifecycle is
// observable without a browser.
function fakePointer(type: string, clientX = 0, clientY = 0): Event {
  return Object.assign(new Event(type), { clientX, clientY });
}

function fakeDivider() {
  const calls: string[] = [];
  return {
    calls,
    setPointerCapture: (id: number) => calls.push(`set:${id}`),
    releasePointerCapture: (id: number) => calls.push(`release:${id}`),
  };
}

function pointerDown(el: unknown, clientX: number, clientY: number): PointerEvent {
  return {
    clientX,
    clientY,
    pointerId: 7,
    currentTarget: el,
    preventDefault: () => {},
  } as unknown as PointerEvent;
}

describe('startDividerDrag', () => {
  let savedWindow: unknown;
  beforeEach(() => {
    savedWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = new EventTarget();
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = savedWindow;
  });

  test('reports the fraction dragged along the axis until pointerup', () => {
    const el = fakeDivider();
    const seen: number[] = [];
    startDividerDrag({
      event: pointerDown(el, 100, 0),
      axis: 'x',
      size: 200,
      onFraction: (f) => seen.push(f),
    });
    window.dispatchEvent(fakePointer('pointermove', 150));
    window.dispatchEvent(fakePointer('pointerup'));
    window.dispatchEvent(fakePointer('pointermove', 300));
    expect(seen).toEqual([0.25]);
    expect(el.calls).toEqual(['set:7', 'release:7']);
  });

  test('a mouseup ends the drag when the engine swallows pointerup (WebKitGTK)', () => {
    const el = fakeDivider();
    const seen: number[] = [];
    startDividerDrag({
      event: pointerDown(el, 0, 50),
      axis: 'y',
      size: 100,
      onFraction: (f) => seen.push(f),
    });
    window.dispatchEvent(fakePointer('pointermove', 0, 60));
    window.dispatchEvent(fakePointer('mouseup'));
    // The stale-listener bug: without the fallback this later move still drags.
    window.dispatchEvent(fakePointer('pointermove', 0, 90));
    expect(seen).toEqual([0.1]);
    expect(el.calls).toEqual(['set:7', 'release:7']);
  });

  test('finishes once when both pointerup and mouseup arrive', () => {
    const el = fakeDivider();
    startDividerDrag({ event: pointerDown(el, 0, 0), axis: 'x', size: 1, onFraction: () => {} });
    window.dispatchEvent(fakePointer('pointerup'));
    window.dispatchEvent(fakePointer('mouseup'));
    expect(el.calls).toEqual(['set:7', 'release:7']);
  });
});

describe('startPointerDrag', () => {
  let savedWindow: unknown;
  beforeEach(() => {
    savedWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = new EventTarget();
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = savedWindow;
  });

  test('reports total px travel on the axis and calls onEnd exactly once', () => {
    const el = fakeDivider();
    const seen: number[] = [];
    let ends = 0;
    startPointerDrag({
      event: pointerDown(el, 40, 500),
      axis: 'x',
      onMove: (d) => seen.push(d),
      onEnd: () => ends++,
    });
    window.dispatchEvent(fakePointer('pointermove', 55, 0));
    window.dispatchEvent(fakePointer('pointermove', 10, 0));
    window.dispatchEvent(fakePointer('mouseup'));
    window.dispatchEvent(fakePointer('pointerup'));
    window.dispatchEvent(fakePointer('pointermove', 90, 0));
    expect(seen).toEqual([15, -30]);
    expect(ends).toBe(1);
    expect(el.calls).toEqual(['set:7', 'release:7']);
  });
});
