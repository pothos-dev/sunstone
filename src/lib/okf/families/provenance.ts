// Provenance family (§5.1): `sources` and `usage_window` (ov-10).
//
// Lint (`sunstone_shared::okf_lint`, family `okf-provenance`): `resource` is
// REQUIRED in every `sources` entry (an error); shapes, duplicate ids,
// `usage_count`, `usage_window` and `last_modified` are warnings or info.
// No credibility score is computed: the signals are checked for shape only.

import type { CompletionOption, OkfFamily } from '../family';

const fromTo = [
  { label: 'from', detail: 'datetime', info: 'ISO 8601 with a UTC offset, e.g. `2026-06-01T00:00:00Z`.' },
  { label: 'to', detail: 'datetime', info: 'ISO 8601 with a UTC offset, e.g. `2026-06-30T00:00:00Z`.' },
];

/** The actor forms of §7, offered as a start for `author`. */
const actorStarts: CompletionOption[] = [
  { label: 'human:', detail: 'person', info: 'A person, e.g. `human:alice`.', apply: 'human:' },
  { label: 'process:', detail: 'process', info: 'An automated process, e.g. `process:nightly`.', apply: 'process:' },
];

export const provenance: OkfFamily = {
  id: 'okf-provenance',
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
    { path: ['sources', '*', 'author'], values: actorStarts },
    { path: ['usage_window'], keys: fromTo },
    { path: ['sources', '*', 'usage_window'], keys: fromTo },
  ],
};
