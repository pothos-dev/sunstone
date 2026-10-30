// Trust family (§5.2): `generated` and `verified`. Owned by ov-9.
//
// Lint (`sunstone_shared::okf_lint`, family `okf-trust`): the REQUIRED
// `generated.by` (an error); a non-ISO `at`, a `generated` that is not a
// `{ by, at }` mapping, and a malformed `verified` are warnings.
//
// Value completions: an `at` offers the current time in UTC (`…Z`, the form
// the spec asks for), a `by` offers the `human:` / `process:` actor prefixes.

import { isoUtc } from '$lib/instant';
import type { CompletionOption, CompletionSpec, OkfFamily } from '../family';

const byAt = [
  { label: 'by', detail: 'actor', info: 'Who or what: an actor (§7), e.g. `human:alice`.' },
  { label: 'at', detail: 'datetime', info: 'ISO 8601 with a UTC offset, e.g. `2026-06-30T14:00:00Z`.' },
];

const byValues: CompletionOption[] = [
  { label: 'human:', detail: 'person', info: 'A person: `human:<id>` (§7). A person verifying makes the Concept human-reviewed.' },
  { label: 'process:', detail: 'process', info: 'An automated process: `process:<id>` (§7).' },
];

/** An `at` value offers "now"; a getter, so the time is taken when completing. */
function atSpec(path: string[]): CompletionSpec {
  return {
    path,
    get values(): CompletionOption[] {
      return [{ label: isoUtc(new Date()), detail: 'now (UTC)', info: 'The current time, ISO 8601 with a UTC offset.' }];
    },
  };
}

export const trust: OkfFamily = {
  id: 'okf-trust',
  completions: [
    {
      path: [],
      keys: [
        { label: 'generated', detail: 'trust', info: 'How the content was produced: `{ by, at }` (§5.2).' },
        { label: 'verified', detail: 'trust', info: 'Who confirmed it: a list of `{ by, at }` events (§5.2).' },
      ],
    },
    { path: ['generated'], keys: byAt },
    { path: ['verified', '*'], keys: byAt },
    { path: ['generated', 'by'], values: byValues },
    { path: ['verified', '*', 'by'], values: byValues },
    // A bare `verified` mapping (§5.2).
    { path: ['verified', 'by'], values: byValues },
    atSpec(['generated', 'at']),
    atSpec(['verified', '*', 'at']),
    atSpec(['verified', 'at']),
  ],
};
