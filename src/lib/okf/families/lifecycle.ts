// Lifecycle family (§5.4, §5.5): `status` and `stale_after`. Owned by ov-11,
// which adds its rules and value completions here (the `status` enum, the
// `stale_after` datetime …). ov-3 seeds only the opt-in keys.

import type { OkfFamily } from '../family';

export const lifecycle: OkfFamily = {
  id: 'okf-lifecycle',
  keys: ['status', 'stale_after'],
  completions: [
    {
      path: [],
      keys: [
        { label: 'status', detail: 'lifecycle', info: '`draft`, `stable` or `deprecated` (§5.4).' },
        { label: 'stale_after', detail: 'lifecycle', info: 'ISO 8601 instant after which the content is stale (§5.5).' },
      ],
    },
  ],
};
