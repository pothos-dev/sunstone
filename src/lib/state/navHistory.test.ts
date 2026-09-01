import { describe, expect, test } from 'bun:test';
import {
  EMPTY_HISTORY,
  canGoBack,
  canGoForward,
  currentOffset,
  goBack,
  goForward,
  pushEntry,
  remapHistory,
  setOffset,
  type NavHistory,
} from './navHistory';

const h = (entries: string[], index: number, offsets?: number[]): NavHistory => ({
  entries,
  offsets: offsets ?? entries.map(() => 0),
  index,
});

describe('navHistory', () => {
  test('empty history has no moves', () => {
    expect(canGoBack(EMPTY_HISTORY)).toBe(false);
    expect(canGoForward(EMPTY_HISTORY)).toBe(false);
  });

  test('pushEntry appends and points the cursor at the new entry', () => {
    const a = pushEntry(EMPTY_HISTORY, 'a.md');
    expect(a).toEqual(h(['a.md'], 0));
    const b = pushEntry(a, 'b.md');
    expect(b).toEqual(h(['a.md', 'b.md'], 1));
  });

  test('pushEntry truncates forward history (browser semantics)', () => {
    const forked = pushEntry(goBack(h(['a.md', 'b.md', 'c.md'], 2)), 'd.md');
    // From c(2) go back to b(1), then open d: c is dropped.
    expect(forked).toEqual(h(['a.md', 'b.md', 'd.md'], 2));
  });

  test('canGoBack / canGoForward reflect the cursor position', () => {
    const mid = h(['a.md', 'b.md', 'c.md'], 1);
    expect(canGoBack(mid)).toBe(true);
    expect(canGoForward(mid)).toBe(true);
    expect(canGoBack(h(['a.md', 'b.md'], 0))).toBe(false);
    expect(canGoForward(h(['a.md', 'b.md'], 1))).toBe(false);
  });

  test('goBack / goForward move the cursor and clamp at the ends', () => {
    const start = h(['a.md', 'b.md'], 1);
    expect(goBack(start)).toEqual(h(['a.md', 'b.md'], 0));
    // Already at the front: unchanged.
    expect(goBack(h(['a.md', 'b.md'], 0))).toEqual(h(['a.md', 'b.md'], 0));
    expect(goForward(h(['a.md', 'b.md'], 0))).toEqual(h(['a.md', 'b.md'], 1));
    // Already at the end: unchanged.
    expect(goForward(start)).toEqual(start);
  });

  test('remapHistory rewrites renamed entries and reports the change', () => {
    const before = h(['a.md', 'dir/b.md', 'dir/c.md'], 2);
    const { history, changed } = remapHistory(before, 'dir', 'moved');
    expect(changed).toBe(true);
    expect(history).toEqual(h(['a.md', 'moved/b.md', 'moved/c.md'], 2));
  });

  test('remapHistory is a no-op when nothing matches', () => {
    const before = h(['a.md', 'b.md'], 1);
    const { history, changed } = remapHistory(before, 'x.md', 'y.md');
    expect(changed).toBe(false);
    expect(history).toEqual(before);
  });

  test('a fresh entry starts at the top; scrolling is remembered per entry', () => {
    let hist = pushEntry(EMPTY_HISTORY, 'a.md');
    hist = setOffset(hist, 420);
    expect(currentOffset(hist)).toBe(420);

    // Following a link lands at the top of the new Concept.
    hist = pushEntry(hist, 'b.md');
    expect(currentOffset(hist)).toBe(0);
    hist = setOffset(hist, 90);

    // Back restores a.md's offset; Forward restores b.md's.
    hist = goBack(hist);
    expect(currentOffset(hist)).toBe(420);
    hist = goForward(hist);
    expect(currentOffset(hist)).toBe(90);
  });

  test('setOffset on an empty history is a no-op', () => {
    expect(setOffset(EMPTY_HISTORY, 10)).toBe(EMPTY_HISTORY);
    expect(currentOffset(EMPTY_HISTORY)).toBe(0);
  });

  test('remapHistory keeps the remembered offsets', () => {
    const { history } = remapHistory(h(['old/a.md', 'b.md'], 0, [12, 34]), 'old', 'new');
    expect(history.entries).toEqual(['new/a.md', 'b.md']);
    expect(history.offsets).toEqual([12, 34]);
  });
});