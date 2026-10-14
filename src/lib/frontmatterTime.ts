// Frontmatter timestamps for display (ov-24). Pure; no DOM, IPC or runes.
//
// Every timestamp Sunstone shows from Frontmatter (`generated.at`,
// `verified[].at`, `stale_after`, a source's `last_modified`, `usage_window`)
// reads relative — "3 days ago", "yesterday", "in 2 weeks" — with the absolute
// local date and time on hover. Only a value the shared ISO check accepts
// (`isIsoDatetime`: ISO 8601 with an explicit offset, ov-19) gets a relative
// form; anything else is shown as written. This is display formatting, so it
// stays in TS; callers re-run it on the once-a-minute `clock`.
//
// `usagePhrase` words a source's `usage_count` over its `usage_window`
// (`1,280× used in September 2026`). The native render writes the same words
// (`usage_phrase` in `sunstone-native/src/render/footnotes.rs`); both assert
// the same cases.

import { isIsoDatetime } from '$lib/wasm/exports';
import { parseInstant } from '$lib/instant';

/** A timestamp ready for a `<time datetime=… title=…>text</time>`. */
export interface FrontmatterTime {
  /** Relative wording: `3 days ago`, `yesterday`, `in 2 weeks`, `now`. */
  text: string;
  /** The absolute local date and time, for the hover. */
  title: string;
  /** The value as written (the `datetime` attribute). */
  datetime: string;
}

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const ABSOLUTE = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30.44 * DAY;
const YEAR = 365.25 * DAY;

/** The relative wording of `ms` seen from `now`. */
function relative(ms: number, now: number): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const at = (unit: Intl.RelativeTimeFormatUnit, size: number) => RTF.format(Math.round(diff / size), unit);
  if (abs < MINUTE) return RTF.format(0, 'second');
  if (abs < HOUR) return at('minute', MINUTE);
  if (abs < DAY) return at('hour', HOUR);
  if (abs < WEEK) return at('day', DAY);
  if (abs < 4 * WEEK) return at('week', WEEK);
  if (abs < YEAR) return at('month', MONTH);
  return at('year', YEAR);
}

/**
 * `raw` as a relative timestamp at `now`, or `null` when it is missing or not
 * an ISO 8601 datetime with an offset (show it as written then).
 */
export function frontmatterTime(raw: string | null | undefined, now: number): FrontmatterTime | null {
  if (raw == null) return null;
  const value = raw.trim();
  if (value === '' || !isIsoDatetime(value)) return null;
  const ms = parseInstant(value);
  if (ms === null) return null;
  return { text: relative(ms, now), title: ABSOLUTE.format(ms), datetime: value };
}

/** An integer count with thousands separators (`1,280`); anything else as written. */
export function formatCount(count: string): string {
  const t = count.trim();
  return /^\d+$/.test(t) ? t.replace(/\B(?=(\d{3})+$)/g, ',') : t;
}

/** One piece of a phrase: plain text, or a timestamp to show via {@link frontmatterTime}. */
export type PhrasePart = { text: string } | { time: string };

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `[year, month (1-12), day]` of a `YYYY-MM-DD…` value, else `null`. */
function ymd(raw: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `in September 2026` / `in 2025` when the window is one whole calendar month or year. */
function calendarPeriod(from: string, to: string): string | null {
  const a = ymd(from);
  const b = ymd(to);
  if (!a || !b || a[0] !== b[0] || a[2] !== 1 || a[1] < 1 || a[1] > 12) return null;
  if (a[1] === b[1] && b[2] === daysIn(b[0], b[1])) return `in ${MONTHS[a[1] - 1]} ${a[0]}`;
  if (a[1] === 1 && b[1] === 12 && b[2] === 31) return `in ${a[0]}`;
  return null;
}

/**
 * `usage_count` over `usage_window` (§5.1), as one phrase: `1,280× used in
 * September 2026`, `3× used since <time>`, `3× used from <time> to <time>`, or
 * just `7× used` without a window. As written: no score is computed.
 */
export function usagePhrase(
  count: string,
  window: { from?: string | null; to?: string | null } | null | undefined,
): PhrasePart[] {
  const used = `${formatCount(count)}× used`;
  const from = window?.from?.trim() || null;
  const to = window?.to?.trim() || null;
  if (from && to) {
    const period = calendarPeriod(from, to);
    if (period) return [{ text: `${used} ${period}` }];
    return [{ text: `${used} from ` }, { time: from }, { text: ' to ' }, { time: to }];
  }
  if (from) return [{ text: `${used} since ` }, { time: from }];
  if (to) return [{ text: `${used} until ` }, { time: to }];
  return [{ text: used }];
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A Frontmatter timestamp's markup as the renders write it: the value as
 * written, with `datetime` when the shared ISO check accepts it (Rust's
 * `time_html`). {@link refreshFrontmatterTimes} turns it relative in the
 * browser.
 */
export function fmTimeHtml(raw: string): string {
  const at = raw.trim();
  const datetime = isIsoDatetime(at) ? ` datetime="${esc(at)}"` : '';
  return `<time class="fm-time"${datetime} title="${esc(at)}">${esc(at)}</time>`;
}

/** {@link usagePhrase} as markup (Rust's `usage_html`). */
export function usageHtml(
  count: string,
  window: { from?: string | null; to?: string | null } | null | undefined,
): string {
  return usagePhrase(count, window)
    .map((p) => ('time' in p ? fmTimeHtml(p.time) : esc(p.text)))
    .join('');
}

/**
 * Show every `time.fm-time[datetime]` under `root` relative to `now`, with the
 * absolute local time as its tooltip. Idempotent: call it after rendering and
 * on every `clock` tick.
 */
export function refreshFrontmatterTimes(root: ParentNode, now: number): void {
  for (const el of root.querySelectorAll<HTMLTimeElement>('time.fm-time[datetime]')) {
    const t = frontmatterTime(el.dateTime, now);
    if (!t) continue;
    if (el.textContent !== t.text) el.textContent = t.text;
    if (el.title !== t.title) el.title = t.title;
  }
}
