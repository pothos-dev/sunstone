/** Compact "time since" label (e.g. "3h ago"), or '' when `ms` is null. */
export function relativeTime(ms: number | null, now: number = Date.now()): string {
  if (ms === null) return '';
  const diff = now - ms;
  if (diff < 0) return 'just now';
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  const week = 7 * day;
  if (diff < min) return 'just now';
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < week) return `${Math.floor(diff / day)}d ago`;
  if (diff < 5 * week) return `${Math.floor(diff / week)}w ago`;
  return new Date(ms).toLocaleDateString();
}
