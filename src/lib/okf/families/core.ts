// The §4.1 core: the keys every OKF Concept has or is recommended to have.
// Always on in an OKF Bundle (`keys: []`).

import { isScalar, isSeq } from 'yaml';
import { isStringScalar, pairRange, type OkfFamily, type OkfRule } from '../family';

/** `title`, `description`, `resource` (and a non-empty `type`) should be text. */
const SCALAR_STRING_KEYS = ['type', 'title', 'description', 'resource'] as const;

const stringKeys: OkfRule = (ctx) => {
  const out = [];
  for (const key of SCALAR_STRING_KEYS) {
    const p = ctx.pair(ctx.root, key);
    // Absent or empty is the REQUIRED check's business (for `type`) or fine.
    if (!p || p.value === null || (isScalar(p.value) && p.value.value === null)) continue;
    if (isStringScalar(p.value)) continue;
    const hint = isScalar(p.value) ? ' (quote it to keep it text)' : '';
    out.push(ctx.at(pairRange(p, [0, 0]), 'warning', `\`${key}\` should be a string${hint} (OKF §4.1)`));
  }
  return out;
};

const tagsList: OkfRule = (ctx) => {
  const p = ctx.pair(ctx.root, 'tags');
  if (!p || p.value === null || (isScalar(p.value) && p.value.value === null)) return [];
  const ok = isSeq(p.value) && p.value.items.every((item) => isStringScalar(item));
  return ok
    ? []
    : [ctx.at(pairRange(p, [0, 0]), 'warning', '`tags` should be a list of strings, e.g. `[a, b]` (OKF §4.1)')];
};

export const core: OkfFamily = {
  id: 'okf',
  keys: [],
  required: [{ path: [], key: 'type', spec: '§4.1' }],
  rules: [stringKeys, tagsList],
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
