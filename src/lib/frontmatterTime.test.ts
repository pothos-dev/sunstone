import { describe, expect, test } from 'bun:test';
import { fmTimeHtml, formatCount, frontmatterTime, usageHtml, usagePhrase } from './frontmatterTime';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0); // 2026-10-14T12:00:00Z

describe('frontmatterTime', () => {
  test('past and future, English wording', () => {
    expect(frontmatterTime('2026-10-11T12:00:00Z', NOW)?.text).toBe('3 days ago');
    expect(frontmatterTime('2026-10-13T12:00:00Z', NOW)?.text).toBe('yesterday');
    expect(frontmatterTime('2026-10-28T12:00:00Z', NOW)?.text).toBe('in 2 weeks');
    expect(frontmatterTime('2026-10-14T11:58:00Z', NOW)?.text).toBe('2 minutes ago');
    expect(frontmatterTime('2026-10-14T09:00:00Z', NOW)?.text).toBe('3 hours ago');
    expect(frontmatterTime('2026-10-14T12:00:10Z', NOW)?.text).toBe('now');
    expect(frontmatterTime('2026-07-14T12:00:00Z', NOW)?.text).toBe('3 months ago');
    expect(frontmatterTime('2000-01-01T00:00:00Z', NOW)?.text).toBe('27 years ago');
  });

  test('the offset is honoured', () => {
    expect(frontmatterTime('2026-10-14T14:00:00+02:00', NOW)?.text).toBe('now');
  });

  test('datetime keeps the value; title is the absolute local date and time', () => {
    const r = frontmatterTime('2026-10-11T12:00:00Z', NOW)!;
    expect(r.datetime).toBe('2026-10-11T12:00:00Z');
    const local = new Date(Date.UTC(2026, 9, 11, 12)).toLocaleString('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    expect(r.title).toBe(local);
  });

  test('a value that is not ISO 8601 with an offset gets no relative form', () => {
    expect(frontmatterTime('soon', NOW)).toBeNull();
    expect(frontmatterTime('2026-10-11', NOW)).toBeNull();
    expect(frontmatterTime('', NOW)).toBeNull();
    expect(frontmatterTime(null, NOW)).toBeNull();
  });
});

describe('formatCount', () => {
  test('groups an integer count; anything else is as written', () => {
    expect(formatCount('1280')).toBe('1,280');
    expect(formatCount('5')).toBe('5');
    expect(formatCount('about 5k')).toBe('about 5k');
  });
});

describe('usagePhrase', () => {
  test('a whole calendar month', () => {
    expect(usagePhrase('1280', { from: '2026-09-01', to: '2026-09-30' })).toEqual([
      { text: '1,280× used in September 2026' },
    ]);
    expect(usagePhrase('3', { from: '2024-02-01T00:00:00Z', to: '2024-02-29T23:59:59Z' })).toEqual([
      { text: '3× used in February 2024' },
    ]);
  });

  test('a whole calendar year', () => {
    expect(usagePhrase('3', { from: '2025-01-01', to: '2025-12-31' })).toEqual([{ text: '3× used in 2025' }]);
  });

  test('open bounds and other ranges keep their bounds as times', () => {
    expect(usagePhrase('3', { from: '2026-01-01', to: null })).toEqual([
      { text: '3× used since ' },
      { time: '2026-01-01' },
    ]);
    expect(usagePhrase('3', { from: null, to: '2026-06-30' })).toEqual([
      { text: '3× used until ' },
      { time: '2026-06-30' },
    ]);
    expect(usagePhrase('3', { from: '2026-01-15', to: '2026-03-31' })).toEqual([
      { text: '3× used from ' },
      { time: '2026-01-15' },
      { text: ' to ' },
      { time: '2026-03-31' },
    ]);
  });

  test('no window, no phrase', () => {
    expect(usagePhrase('7', null)).toEqual([{ text: '7× used' }]);
    expect(usagePhrase('7', { from: null, to: null })).toEqual([{ text: '7× used' }]);
  });
});

// The same cases as `usage_phrases_match_the_frontend` in
// `sunstone-native/src/render/footnotes.rs`.
describe('markup', () => {
  test('fmTimeHtml carries datetime only for an ISO value', () => {
    expect(fmTimeHtml('2026-05-30T00:00:00Z')).toBe(
      '<time class="fm-time" datetime="2026-05-30T00:00:00Z" title="2026-05-30T00:00:00Z">2026-05-30T00:00:00Z</time>',
    );
    expect(fmTimeHtml('2026-05-30')).toBe('<time class="fm-time" title="2026-05-30">2026-05-30</time>');
    expect(fmTimeHtml('<b>')).toBe('<time class="fm-time" title="&lt;b&gt;">&lt;b&gt;</time>');
  });

  test('usageHtml matches the native render', () => {
    expect(usageHtml('1280', { from: '2026-09-01', to: '2026-09-30' })).toBe('1,280× used in September 2026');
    expect(usageHtml('3', { from: '2024-02-01T00:00:00Z', to: '2024-02-29T23:59:59Z' })).toBe(
      '3× used in February 2024',
    );
    expect(usageHtml('3', { from: '2025-01-01', to: '2025-12-31' })).toBe('3× used in 2025');
    expect(usageHtml('3', { from: '2026-01-15', to: '2026-03-31' })).toBe(
      '3× used from <time class="fm-time" title="2026-01-15">2026-01-15</time> to <time class="fm-time" title="2026-03-31">2026-03-31</time>',
    );
    expect(usageHtml('3', { from: null, to: '2026-06-30' })).toBe(
      '3× used until <time class="fm-time" title="2026-06-30">2026-06-30</time>',
    );
    expect(usageHtml('7', null)).toBe('7× used');
    expect(usageHtml('about 5k', null)).toBe('about 5k× used');
    expect(formatCount('1234567')).toBe('1,234,567');
  });
});
