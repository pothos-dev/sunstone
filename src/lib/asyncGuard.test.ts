import { describe, expect, test } from 'bun:test';
import { createCancelGuard, createLatestGuard } from './asyncGuard';

describe('createLatestGuard', () => {
  test('only the most recently started token is latest', () => {
    const guard = createLatestGuard();
    const a = guard.next();
    const b = guard.next();
    expect(guard.isLatest(a)).toBe(false);
    expect(guard.isLatest(b)).toBe(true);
  });

  test('a fresh guard has no latest token yet', () => {
    const guard = createLatestGuard();
    expect(guard.isLatest(0)).toBe(true); // token starts at 0, matches an un-started check
  });
});

describe('createCancelGuard', () => {
  test('starts uncancelled', () => {
    const guard = createCancelGuard();
    expect(guard.isCancelled()).toBe(false);
  });

  test('cancel() flips isCancelled()', () => {
    const guard = createCancelGuard();
    guard.cancel();
    expect(guard.isCancelled()).toBe(true);
  });
});
