// ISO 8601 instants as OKF v0.2 writes them (`stale_after`, §5.5): strict
// parsing, the offset check, and the canonical write form. Pure; no DOM.
//
// `Date.parse` is deliberately not used: it accepts far more than ISO 8601 and
// reads an offset-less datetime as LOCAL time, so the same file would go stale
// at different moments on different machines. Here an offset-less value is read
// as UTC — it still displays and still compares ("displays rather than errors"),
// and the language service warns that it lacks an offset.

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?)?$/;

/**
 * The epoch milliseconds of an ISO 8601 date or datetime, or `null` when
 * `raw` is not one (including impossible dates such as `2026-02-30`). A value
 * with no UTC offset is read as UTC.
 */
export function parseInstant(raw: string): number | null {
  const m = ISO.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '', , sign, oh = '0', om = '0'] = m;
  const year = +y;
  const month = +mo - 1;
  const day = +d;
  if (+h > 23 || +mi > 59 || +s > 59 || +oh > 23 || +om > 59) return null;
  const ms = Number(`0.${frac || '0'}`) * 1000;
  const utc = Date.UTC(year, month, day, +h, +mi, +s, Math.floor(ms));
  // Date.UTC rolls 2026-02-30 over into March: reject what did not survive.
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) return null;
  const offset = sign ? (sign === '-' ? -1 : 1) * (+oh * 60 + +om) * 60_000 : 0;
  return utc - offset;
}

/** Whether `raw` is an ISO 8601 datetime carrying an explicit UTC offset (`Z` or `±hh:mm`). */
export function hasUtcOffset(raw: string): boolean {
  const m = ISO.exec(raw.trim());
  return !!m && (m[8] !== undefined || m[9] !== undefined) && parseInstant(raw) !== null;
}

/** The canonical write form: whole seconds, UTC, `Z` offset (`2026-09-23T00:00:00Z`). */
export function isoUtc(at: Date | number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
