// Trust family (§5.2): `generated` and `verified`. Owned by ov-9.
//
// ov-3 seeded the opt-in keys, the REQUIRED `generated.by` (an error) and the
// key completions. ov-9 adds the warnings and the value completions:
//
// - an `at` that is not ISO 8601 with an explicit UTC offset (the check is the
//   shared Rust `is_iso_datetime` over wasm, the one the trust line uses);
// - a `generated` that is not a `{ by, at }` mapping;
// - a `verified` that is neither a list of events nor ONE bare `{ by, at }`
//   mapping (the bare form is legal, §5.2, and gets no finding), list items
//   that are not mappings, and events missing `by` or `at`.
//
// Value completions: an `at` offers the current time in UTC (`…Z`, the form
// the spec asks for), a `by` offers the `human:` / `process:` actor prefixes.

import { isMap, isScalar, isSeq, type Node, type YAMLMap } from 'yaml';
import { isIsoDatetime } from '$lib/wasm/exports';
import {
  isEmptyValue,
  pairRange,
  type CompletionOption,
  type CompletionSpec,
  type Finding,
  type OkfFamily,
  type OkfRule,
  type Range,
  type RuleContext,
} from '../family';

const byAt = [
  { label: 'by', detail: 'actor', info: 'Who or what: an actor (§7), e.g. `human:alice`.' },
  { label: 'at', detail: 'datetime', info: 'ISO 8601 with a UTC offset, e.g. `2026-06-30T14:00:00Z`.' },
];

const ISO_HINT = 'an ISO 8601 datetime with a UTC offset, e.g. `2026-06-30T14:00:00Z` (OKF §5.2)';

/** `now` as an ISO 8601 UTC datetime to the second: `2026-06-30T14:00:00Z`. */
export function isoNow(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Each `{ by, at }` map of the trust keys, with the range to blame. */
function stamps(ctx: RuleContext): { map: YAMLMap; anchor: Range }[] {
  const out: { map: YAMLMap; anchor: Range }[] = [];
  for (const { node, anchor } of ctx.nodesAt(['generated'])) {
    if (isMap(node)) out.push({ map: node, anchor });
  }
  for (const { node, anchor } of ctx.nodesAt(['verified'])) {
    // A bare mapping is a one-element list (§5.2).
    if (isMap(node)) out.push({ map: node, anchor });
  }
  for (const { node, anchor } of ctx.nodesAt(['verified', '*'])) {
    if (isMap(node)) out.push({ map: node, anchor });
  }
  return out;
}

/** An `at` that is not ISO 8601 with an offset: shown as written, but warned. */
const isoAt: OkfRule = (ctx) => {
  const out: Finding[] = [];
  for (const { map, anchor } of stamps(ctx)) {
    const p = ctx.pair(map, 'at');
    if (!p || isEmptyValue(p.value)) continue;
    const v = p.value;
    if (isScalar(v) && typeof v.value === 'string' && isIsoDatetime(v.value)) continue;
    out.push(ctx.at(pairRange(p, anchor), 'warning', `\`at\` should be ${ISO_HINT}`));
  }
  return out;
};

const generatedShape: OkfRule = (ctx) => {
  const p = ctx.pair(ctx.root, 'generated');
  // Empty is the REQUIRED `by` check's business.
  if (!p || isEmptyValue(p.value) || isMap(p.value)) return [];
  return [
    ctx.at(pairRange(p, [0, 0]), 'warning', '`generated` should be a mapping `{ by, at }` (OKF §5.2)'),
  ];
};

const verifiedShape: OkfRule = (ctx) => {
  const p = ctx.pair(ctx.root, 'verified');
  if (!p || isEmptyValue(p.value)) return [];
  const v = p.value as Node;
  if (!isMap(v) && !isSeq(v)) {
    return [
      ctx.at(
        pairRange(p, [0, 0]),
        'warning',
        '`verified` should be a list of `{ by, at }` events (OKF §5.2)',
      ),
    ];
  }
  const out: Finding[] = [];
  for (const { node, anchor } of ctx.nodesAt(['verified', '*'])) {
    if (!isMap(node)) {
      out.push(ctx.at(anchor, 'warning', 'A verification event should be a mapping `{ by, at }` (OKF §5.2)'));
    }
  }
  const events = isMap(v)
    ? ctx.nodesAt(['verified'])
    : ctx.nodesAt(['verified', '*']).filter((l) => isMap(l.node));
  for (const { node, anchor } of events) {
    const map = node as YAMLMap;
    for (const [key, what] of [
      ['by', 'who confirmed it'],
      ['at', 'when'],
    ] as const) {
      const kp = ctx.pair(map, key);
      if (!kp || isEmptyValue(kp.value)) {
        out.push(
          ctx.at(
            kp ? pairRange(kp, anchor) : anchor,
            'warning',
            `A verification event should say ${what}: \`${key}\` (OKF §5.2)`,
          ),
        );
      }
    }
  }
  return out;
};

const byValues: CompletionOption[] = [
  { label: 'human:', detail: 'person', info: 'A person: `human:<id>` (§7). A person verifying makes the Concept human-reviewed.' },
  { label: 'process:', detail: 'process', info: 'An automated process: `process:<id>` (§7).' },
];

/** An `at` value offers "now"; a getter, so the time is taken when completing. */
function atSpec(path: string[]): CompletionSpec {
  return {
    path,
    get values(): CompletionOption[] {
      return [{ label: isoNow(), detail: 'now (UTC)', info: 'The current time, ISO 8601 with a UTC offset.' }];
    },
  };
}

export const trust: OkfFamily = {
  id: 'okf-trust',
  keys: ['generated', 'verified'],
  required: [{ path: ['generated'], key: 'by', spec: '§5.2' }],
  rules: [generatedShape, verifiedShape, isoAt],
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
