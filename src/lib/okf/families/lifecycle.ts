// Lifecycle family (§5.4, §5.5): `status` and `stale_after` (ov-11).
//
// Lint: a `status` outside `draft | stable | deprecated` is an error (the spec
// defines exactly three); a `stale_after` that is not an ISO 8601 instant, or
// lacks a UTC offset, is a warning — the value still displays and still
// compares (`$lib/lifecycle`), it just is not portable. A PAST `stale_after` is
// never a finding: staleness is an advisory display signal, not a defect.
//
// Completion: the three `status` values, and for `stale_after` a few future
// instants written the canonical way (`isoUtc`: whole seconds, `Z` offset).

import { isScalar } from 'yaml';
import { isoUtc, parseInstant } from '$lib/instant';
import { isIsoDatetime } from '$lib/wasm/exports';
import { LIFECYCLE_STATUSES, STATUS_MEANING, isLifecycleStatus } from '$lib/lifecycle';
import { lineFrom, rangeOf, type CompletionOption, type OkfFamily, type OkfRule, type RuleContext } from '../family';
import type { Pair } from 'yaml';

/** Where a finding about `pair`'s value goes: the value, or the key line when it is empty. */
function valueRange(ctx: RuleContext, pair: Pair) {
  const keyStart = rangeOf(pair.key, [0, 0])[0];
  const empty = pair.value === null || (isScalar(pair.value) && pair.value.value === null);
  return empty ? lineFrom(ctx.yaml, keyStart) : rangeOf(pair.value, lineFrom(ctx.yaml, keyStart));
}

const statusEnum: OkfRule = (ctx) => {
  const p = ctx.pair(ctx.root, 'status');
  if (!p) return [];
  if (isScalar(p.value) && isLifecycleStatus(p.value.value)) return [];
  return [ctx.at(valueRange(ctx, p), 'error', '`status` must be one of `draft`, `stable`, `deprecated` (OKF §5.4)')];
};

const staleAfterInstant: OkfRule = (ctx) => {
  const p = ctx.pair(ctx.root, 'stale_after');
  if (!p) return [];
  const raw = isScalar(p.value) && typeof p.value.value === 'string' ? p.value.value : null;
  // The same check as the trust family's `at` (shared Rust, `trust::is_iso_datetime`).
  if (raw !== null && isIsoDatetime(raw)) return [];
  const message =
    raw !== null && parseInstant(raw) !== null
      ? '`stale_after` has no UTC offset; it is read as UTC. Write it with one, e.g. `2026-09-23T00:00:00Z` (OKF §5.5)'
      : '`stale_after` should be an ISO 8601 datetime, e.g. `2026-09-23T00:00:00Z` (OKF §5.5)';
  return [ctx.at(valueRange(ctx, p), 'warning', message)];
};

const DAY = 24 * 60 * 60 * 1000;
const HORIZONS: [number, string][] = [
  [30, 'in 30 days'],
  [90, 'in 90 days'],
  [180, 'in 6 months'],
  [365, 'in a year'],
];

/** Future `stale_after` instants at UTC midnight, computed when completion asks. */
function staleAfterOptions(now = Date.now()): CompletionOption[] {
  const midnight = Math.floor(now / DAY) * DAY;
  return HORIZONS.map(([days, detail]) => ({
    label: isoUtc(midnight + days * DAY),
    detail,
    info: 'Content is stale on/after this instant (§5.5).',
  }));
}

export const lifecycle: OkfFamily = {
  id: 'okf-lifecycle',
  keys: ['status', 'stale_after'],
  rules: [statusEnum, staleAfterInstant],
  completions: [
    {
      path: [],
      keys: [
        { label: 'status', detail: 'lifecycle', info: '`draft`, `stable` or `deprecated` (§5.4).' },
        { label: 'stale_after', detail: 'lifecycle', info: 'ISO 8601 instant after which the content is stale (§5.5).' },
      ],
    },
    {
      path: ['status'],
      values: LIFECYCLE_STATUSES.map((s) => ({ label: s, detail: 'lifecycle', info: `${STATUS_MEANING[s]} (§5.4).` })),
    },
    {
      path: ['stale_after'],
      // A getter: the dates are relative to when completion runs.
      get values() {
        return staleAfterOptions();
      },
    },
  ],
};
