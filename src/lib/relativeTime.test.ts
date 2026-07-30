import { describe, expect, test } from 'bun:test';
import { relativeTime } from './relativeTime';

describe('relativeTime', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);

  test('returns empty string for null', () => {
    expect(relativeTime(null, now)).toBe('');
  });

  test('returns "just now" for a future or sub-minute timestamp', () => {
    expect(relativeTime(now + 1000, now)).toBe('just now');
    expect(relativeTime(now - 30_000, now)).toBe('just now');
  });

  test('formats minutes, hours, days, and weeks', () => {
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(relativeTime(now - 3 * 7 * 86_400_000, now)).toBe('3w ago');
  });

  test('falls back to a locale date beyond ~5 weeks', () => {
    const ms = now - 40 * 86_400_000;
    expect(relativeTime(ms, now)).toBe(new Date(ms).toLocaleDateString());
  });
});
