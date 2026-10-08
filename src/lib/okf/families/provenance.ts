// Provenance family (§5.1): `sources` and `usage_window` (ov-10).
//
// REQUIRED: `resource` in every `sources` entry (an error, via `required`).
// Everything else is a warning or info (ADR 0009), and absence is never one:
//   - `sources` is a list, and each entry a map;
//   - `resource`, `id`, `title`, `author` are text, not lists or maps;
//   - an `id` is not repeated (a citation `[^id]` resolves to the first entry);
//   - `usage_count` is a whole number ≥ 0;
//   - `usage_window` (beside `sources` or on an entry) is a `{ from, to }` map
//     whose bounds are ISO 8601 datetimes with a UTC offset (§5), `from` not
//     after `to`; `last_modified` is such a datetime too;
//   - `usage_count` with no `usage_window` anywhere is info: the count has no
//     window to frame it.
// No credibility score is computed: the signals are checked for shape only.

import { isMap, isScalar, isSeq, type Node, type YAMLMap } from 'yaml';
import {
  isEmptyValue,
  pairRange,
  rangeOf,
  type CompletionOption,
  type Finding,
  type OkfFamily,
  type OkfRule,
  type Range,
  type RuleContext,
} from '../family';

const fromTo = [
  { label: 'from', detail: 'datetime', info: 'ISO 8601 with a UTC offset, e.g. `2026-06-01T00:00:00Z`.' },
  { label: 'to', detail: 'datetime', info: 'ISO 8601 with a UTC offset, e.g. `2026-06-30T00:00:00Z`.' },
];

/** The actor forms of §7, offered as a start for `author`. */
const actorStarts: CompletionOption[] = [
  { label: 'human:', detail: 'person', info: 'A person, e.g. `human:alice`.', apply: 'human:' },
  { label: 'process:', detail: 'process', info: 'An automated process, e.g. `process:nightly`.', apply: 'process:' },
];

/** ISO 8601 date-time with an explicit UTC offset (`Z` or `±hh:mm`), §5. */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

const DATETIME_HINT = 'an ISO 8601 datetime with a UTC offset, e.g. `2026-06-30T14:00:00Z` (OKF §5)';

/** Absent, `null` or blank: nothing to check (absence is never a finding). */
function blank(node: unknown): boolean {
  return isEmptyValue(node);
}

/** The entries of `sources` that are maps, when `sources` is a list. */
function entries(ctx: RuleContext): YAMLMap[] {
  const p = ctx.pair(ctx.root, 'sources');
  if (!p || !isSeq(p.value)) return [];
  return (p.value.items as Node[]).filter((n): n is YAMLMap => isMap(n));
}

const sourcesShape: OkfRule = (ctx) => {
  const p = ctx.pair(ctx.root, 'sources');
  if (!p || blank(p.value)) return [];
  if (!isSeq(p.value)) {
    return [
      ctx.at(
        pairRange(p, [0, 0]),
        'warning',
        '`sources` should be a list of entries, each with a `resource` (OKF §5.1)',
      ),
    ];
  }
  const out: Finding[] = [];
  for (const item of p.value.items as Node[]) {
    if (isMap(item) || blank(item)) continue;
    out.push(
      ctx.at(
        rangeOf(item, [0, 0]),
        'warning',
        'A `sources` entry should be a map with a `resource`, e.g. `- resource: https://…` (OKF §5.1)',
      ),
    );
  }
  return out;
};

const TEXT_KEYS = ['resource', 'id', 'title', 'author'] as const;

const entryText: OkfRule = (ctx) => {
  const out: Finding[] = [];
  for (const entry of entries(ctx)) {
    for (const key of TEXT_KEYS) {
      const p = ctx.pair(entry, key);
      if (!p || blank(p.value) || isScalar(p.value)) continue;
      out.push(ctx.at(pairRange(p, [0, 0]), 'warning', `\`${key}\` in a \`sources\` entry should be text (OKF §5.1)`));
    }
  }
  return out;
};

const uniqueIds: OkfRule = (ctx) => {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const entry of entries(ctx)) {
    const p = ctx.pair(entry, 'id');
    if (!p || !isScalar(p.value) || blank(p.value)) continue;
    const id = String(p.value.source ?? p.value.value).toLowerCase();
    if (seen.has(id)) {
      out.push(
        ctx.at(
          rangeOf(p.value, [0, 0]),
          'warning',
          `Duplicate source id \`${id}\`: a citation \`[^${id}]\` resolves to the first entry with it (OKF §5.1)`,
        ),
      );
    }
    seen.add(id);
  }
  return out;
};

const usageCount: OkfRule = (ctx) => {
  const out: Finding[] = [];
  for (const entry of entries(ctx)) {
    const p = ctx.pair(entry, 'usage_count');
    if (!p || blank(p.value)) continue;
    const v = isScalar(p.value) ? p.value.value : undefined;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) continue;
    out.push(
      ctx.at(
        pairRange(p, [0, 0]),
        'warning',
        '`usage_count` should be a whole number of exercises, e.g. `5000` (OKF §5.1)',
      ),
    );
  }
  return out;
};

/** A datetime-valued scalar that is not `DATETIME_HINT`, as a finding. */
function datetime(ctx: RuleContext, node: unknown, key: string, fallback: Range): Finding[] {
  if (blank(node)) return [];
  const v = isScalar(node) ? node.value : undefined;
  if (typeof v === 'string' && ISO_DATETIME.test(v.trim())) return [];
  return [ctx.at(rangeOf(node, fallback), 'warning', `\`${key}\` should be ${DATETIME_HINT}`)];
}

/** Checks one `usage_window` value: a `{ from, to }` map, in order. */
function windowFindings(ctx: RuleContext, node: unknown, fallback: Range): Finding[] {
  if (blank(node)) return [];
  if (!isMap(node)) {
    return [
      ctx.at(
        rangeOf(node, fallback),
        'warning',
        '`usage_window` should be a `{ from, to }` datetime range (OKF §5.1)',
      ),
    ];
  }
  const from = ctx.pair(node, 'from');
  const to = ctx.pair(node, 'to');
  const out = [
    ...(from ? datetime(ctx, from.value, 'usage_window.from', fallback) : []),
    ...(to ? datetime(ctx, to.value, 'usage_window.to', fallback) : []),
  ];
  if (out.length === 0 && from && to && isScalar(from.value) && isScalar(to.value)) {
    const [a, b] = [Date.parse(String(from.value.value)), Date.parse(String(to.value.value))];
    if (!Number.isNaN(a) && !Number.isNaN(b) && a > b) {
      out.push(ctx.at(rangeOf(node, fallback), 'warning', '`usage_window.from` is after `usage_window.to`'));
    }
  }
  return out;
}

const usageWindows: OkfRule = (ctx) => {
  const out: Finding[] = [];
  const top = ctx.pair(ctx.root, 'usage_window');
  if (top) out.push(...windowFindings(ctx, top.value, rangeOf(top.key, [0, 0])));
  for (const entry of entries(ctx)) {
    const p = ctx.pair(entry, 'usage_window');
    if (p) out.push(...windowFindings(ctx, p.value, rangeOf(p.key, [0, 0])));
  }
  return out;
};

const lastModified: OkfRule = (ctx) =>
  entries(ctx).flatMap((entry) => {
    const p = ctx.pair(entry, 'last_modified');
    return p ? datetime(ctx, p.value, 'last_modified', rangeOf(p.key, [0, 0])) : [];
  });

const unframedCounts: OkfRule = (ctx) => {
  const top = ctx.pair(ctx.root, 'usage_window');
  if (top && !blank(top.value)) return [];
  const out: Finding[] = [];
  for (const entry of entries(ctx)) {
    const count = ctx.pair(entry, 'usage_count');
    const own = ctx.pair(entry, 'usage_window');
    if (!count || blank(count.value) || (own && !blank(own.value))) continue;
    out.push(
      ctx.at(
        rangeOf(count.key, [0, 0]),
        'info',
        '`usage_count` has no `usage_window` to frame it: add `usage_window: { from, to }` beside `sources` or on this entry (OKF §5.1)',
      ),
    );
  }
  return out;
};

export const provenance: OkfFamily = {
  id: 'okf-provenance',
  keys: ['sources', 'usage_window'],
  required: [{ path: ['sources', '*'], key: 'resource', spec: '§5.1' }],
  rules: [sourcesShape, entryText, uniqueIds, usageCount, usageWindows, lastModified, unframedCounts],
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
