// Trust family (§5.2): `generated` and `verified`. Owned by ov-9, which adds
// its rules here (non-ISO `at`, the bare `verified` mapping, actor shape …).
// ov-3 seeds only what the language service itself must know: the opt-in keys,
// the REQUIRED `generated.by`, and the keys to complete.

import type { OkfFamily } from '../family';

const byAt = [
  { label: 'by', detail: 'actor', info: 'Who or what: an actor (§7), e.g. `human:alice`.' },
  { label: 'at', detail: 'datetime', info: 'ISO 8601 with a UTC offset, e.g. `2026-06-30T14:00:00Z`.' },
];

export const trust: OkfFamily = {
  id: 'okf-trust',
  keys: ['generated', 'verified'],
  required: [{ path: ['generated'], key: 'by', spec: '§5.2' }],
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
  ],
};
