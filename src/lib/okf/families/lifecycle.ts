// Lifecycle family (§5.4, §5.5): `status` and `stale_after` (ov-11).
//
// Lint (`sunstone_shared::okf_lint`, family `okf-lifecycle`): a `status`
// outside `draft | stable | deprecated` is an error; a `stale_after` that is
// not an ISO 8601 instant, or lacks a UTC offset, is a warning. A PAST
// `stale_after` is never a finding: staleness is advisory, not a defect.
//
// Completion: the three `status` values, and for `stale_after` a few future
// instants written the canonical way (`isoUtc`: whole seconds, `Z` offset).

import { isoUtc } from '$lib/instant';
import { LIFECYCLE_STATUSES, STATUS_MEANING } from '$lib/lifecycle';
import type { CompletionOption, OkfFamily } from '../family';

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
