// Provenance family (§5.1): `sources` and `usage_window`. Owned by ov-10, which
// adds its rules here (`sources` shape, `usage_window` ranges, id joins …).
// ov-3 seeds only the opt-in keys, the REQUIRED `sources[].resource`, and the
// keys to complete.

import type { OkfFamily } from '../family';

const fromTo = [
  { label: 'from', detail: 'datetime' },
  { label: 'to', detail: 'datetime' },
];

export const provenance: OkfFamily = {
  id: 'okf-provenance',
  keys: ['sources', 'usage_window'],
  required: [{ path: ['sources', '*'], key: 'resource', spec: '§5.1' }],
  completions: [
    {
      path: [],
      keys: [
        {
          label: 'sources',
          detail: 'provenance',
          info: 'What this Concept derives from: a list of entries with `resource` (§5.1).',
        },
        {
          label: 'usage_window',
          detail: 'provenance',
          info: 'The `{ from, to }` range every `usage_count` covers (§5.1).',
        },
      ],
    },
    {
      path: ['sources', '*'],
      keys: [
        { label: 'resource', detail: 'required', info: 'A URL, a bundle path, or a scope descriptor.' },
        { label: 'id', detail: 'cite key', info: 'Stable key the body cites as `[^id]`.' },
        { label: 'title', detail: 'label' },
        { label: 'author', detail: 'actor', info: 'Who produced the source (§7).' },
        { label: 'usage_count', detail: 'number', info: 'How often `resource` was exercised over `usage_window`.' },
        { label: 'last_modified', detail: 'datetime', info: 'When the source itself last changed.' },
        { label: 'usage_window', detail: 'override', info: "This entry's own `{ from, to }`." },
      ],
    },
    { path: ['usage_window'], keys: fromTo },
    { path: ['sources', '*', 'usage_window'], keys: fromTo },
  ],
};
