import { describe, expect, test } from 'bun:test';
import { hasUtcOffset, isoUtc, parseInstant } from './instant';

describe('parseInstant', () => {
  test('Z and numeric offsets name the same instant', () => {
    const z = parseInstant('2026-09-23T00:00:00Z');
    expect(z).toBe(Date.UTC(2026, 8, 23));
    expect(parseInstant('2026-09-23T02:00:00+02:00')).toBe(z);
    expect(parseInstant('2026-09-22T19:00:00-0500')).toBe(z);
    expect(parseInstant('2026-09-23T00:00:00z')).toBe(z);
  });

  test('fractions, a space separator and minutes-only times', () => {
    expect(parseInstant('2026-09-23T00:00:00.250Z')).toBe(Date.UTC(2026, 8, 23) + 250);
    expect(parseInstant('2026-09-23 10:30Z')).toBe(Date.UTC(2026, 8, 23, 10, 30));
  });

  test('a value without an offset still reads, as UTC', () => {
    expect(parseInstant('2026-09-23T00:00:00')).toBe(Date.UTC(2026, 8, 23));
    expect(parseInstant('2026-09-23')).toBe(Date.UTC(2026, 8, 23));
    expect(parseInstant('  2026-09-23  ')).toBe(Date.UTC(2026, 8, 23));
  });

  test('malformed values are null, never a guess', () => {
    for (const bad of ['', 'soon', '2026', '2026-13-01', '2026-02-30', '2026-09-23T25:00Z', '23.09.2026', '2026-09-23T00:00:00+2']) {
      expect(parseInstant(bad)).toBeNull();
    }
  });
});

describe('hasUtcOffset', () => {
  test('Z or ±hh:mm present', () => {
    expect(hasUtcOffset('2026-09-23T00:00:00Z')).toBe(true);
    expect(hasUtcOffset('2026-09-23T00:00:00+02:00')).toBe(true);
    expect(hasUtcOffset('2026-09-23T00:00:00')).toBe(false);
    expect(hasUtcOffset('2026-09-23')).toBe(false);
    expect(hasUtcOffset('nonsense')).toBe(false);
  });
});

describe('isoUtc', () => {
  test('writes whole seconds with an explicit Z offset', () => {
    expect(isoUtc(Date.UTC(2026, 8, 23, 4, 5, 6, 789))).toBe('2026-09-23T04:05:06Z');
    expect(isoUtc(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-01-01T00:00:00Z');
  });

  test('round-trips through parseInstant', () => {
    const ms = Date.UTC(2027, 5, 30, 12);
    expect(parseInstant(isoUtc(ms))).toBe(ms);
  });
});
