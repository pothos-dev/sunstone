// The §4.1 core: the keys every OKF Concept has or is recommended to have.
// Lint: `sunstone_shared::okf_lint` (family `okf`).

import type { OkfFamily } from '../family';

export const core: OkfFamily = {
  id: 'okf',
  completions: [
    {
      path: [],
      keys: [
        { label: 'type', detail: 'required', info: 'The kind of Concept, e.g. `Metric`, `Playbook`, `Reference`.' },
        { label: 'title', detail: 'recommended', info: 'Human-readable display name.' },
        { label: 'description', detail: 'recommended', info: 'One sentence summarising the Concept.' },
        { label: 'resource', detail: 'recommended', info: 'URI of the underlying asset this Concept describes.' },
        { label: 'tags', detail: 'recommended', info: 'A list of short strings, e.g. `[a, b]`.' },
      ],
    },
  ],
};
