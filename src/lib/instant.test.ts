import { describe, expect, test } from 'bun:test';
import { isoUtc } from './instant';
import { epochSeconds, isIsoDatetime } from '$lib/wasm/exports';

describe('isoUtc', () => {
  test('writes whole seconds with an explicit Z offset', () => {
    expect(isoUtc(Date.UTC(2026, 8, 23, 4, 5, 6, 789))).toBe('2026-09-23T04:05:06Z');
    expect(isoUtc(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-01-01T00:00:00Z');
  });

  test('round-trips through the shared reader', () => {
    const ms = Date.UTC(2027, 5, 30, 12);
    expect(isIsoDatetime(isoUtc(ms))).toBe(true);
    expect(epochSeconds(isoUtc(ms))).toBe(ms / 1000);
  });
});
