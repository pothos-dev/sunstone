// Computation family (§10): the contract of an Attested Computation (ov-12).
//
// Applies only to a Concept whose `type` is `Attested Computation` (the shared
// `isAttestedComputation`, so the editor, the card and the lint agree on what
// counts). That is why this family opts in on `type` rather than on a contract
// key: a computation with none of the contract keys still lacks `runtime`, and
// a Concept of another type may use `runtime` or `parameters` as an unrelated
// extension key (§4.1), which must stay silent.
//
// REQUIRED: `runtime` (§10.2, "REQUIRED for this type"), an error. Everything
// else is a warning (ADR 0009), and absence is never one (§11):
//   - `runtime` is text;
//   - `parameters` is a list of `{ name, type, required }` maps: `name` and
//     `type` present and text, `required` (optional) a boolean, names unique;
//   - `computation`, `executor.resource`, `attester.resource` are paths or
//     URLs (§6.2): text;
//   - `executor` and `attester` are maps; `executor.receipt` a list of names.
// Nothing here runs or verifies the computation: the contract is checked for
// shape only.

import { isMap, isScalar, isSeq, type Node, type YAMLMap } from 'yaml';
import { isAttestedComputation } from '$lib/wasm/exports';
import {
  isEmptyValue,
  isStringScalar,
  pairRange,
  rangeOf,
  type CompletionOption,
  type Finding,
  type OkfFamily,
  type OkfRule,
  type RuleContext,
} from '../family';

const PATH_HINT = 'a URL, a bundle path (`/…`) or a relative path (OKF §6.2)';

/** Whether this Concept is an Attested Computation: every rule's guard. */
function applies(ctx: RuleContext): boolean {
  return isAttestedComputation(ctx.yaml);
}

/** A rule that runs only on an Attested Computation. */
function forComputation(rule: OkfRule): OkfRule {
  return (ctx) => (applies(ctx) ? rule(ctx) : []);
}

const runtimeRequired: OkfRule = (ctx) => {
  const p = ctx.pair(ctx.root, 'runtime');
  const typeKey = ctx.pair(ctx.root, 'type')?.key;
  if (!p) {
    return [
      ctx.at(
        rangeOf(typeKey, [0, 0]),
        'error',
        'Missing required key `runtime` for an Attested Computation, e.g. `runtime: bigquery` (OKF §10.2)',
      ),
    ];
  }
  if (isEmptyValue(p.value)) {
    return [ctx.at(pairRange(p, [0, 0]), 'error', '`runtime` is required but empty (OKF §10.2)')];
  }
  if (!isScalar(p.value)) {
    return [ctx.at(pairRange(p, [0, 0]), 'warning', '`runtime` should be text, e.g. `bigquery` (OKF §10.2)')];
  }
  return [];
};

/** A path-valued field (§6.2) that is set but is not text. */
function pathText(ctx: RuleContext, map: YAMLMap, key: string, label: string): Finding[] {
  const p = ctx.pair(map, key);
  if (!p || isEmptyValue(p.value) || isStringScalar(p.value)) return [];
  return [ctx.at(pairRange(p, [0, 0]), 'warning', `\`${label}\` should be ${PATH_HINT}`)];
}

const parameters: OkfRule = (ctx) => {
  const p = ctx.pair(ctx.root, 'parameters');
  if (!p || isEmptyValue(p.value)) return [];
  if (!isSeq(p.value)) {
    return [
      ctx.at(
        pairRange(p, [0, 0]),
        'warning',
        '`parameters` should be a list of `{ name, type, required }` entries (OKF §10.2)',
      ),
    ];
  }
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const item of p.value.items as Node[]) {
    if (isEmptyValue(item)) continue;
    const range = rangeOf(item, [0, 0]);
    if (!isMap(item)) {
      out.push(
        ctx.at(range, 'warning', 'A parameter should be a map, e.g. `- { name: year, type: integer }` (OKF §10.2)'),
      );
      continue;
    }
    for (const key of ['name', 'type'] as const) {
      const kp = ctx.pair(item, key);
      if (!kp || isEmptyValue(kp.value)) {
        out.push(ctx.at(range, 'warning', `A parameter should have a \`${key}\` (OKF §10.2)`));
      } else if (!isScalar(kp.value)) {
        out.push(ctx.at(pairRange(kp, range), 'warning', `A parameter's \`${key}\` should be text (OKF §10.2)`));
      }
    }
    const req = ctx.pair(item, 'required');
    if (req && !isEmptyValue(req.value) && !(isScalar(req.value) && typeof req.value.value === 'boolean')) {
      out.push(
        ctx.at(pairRange(req, range), 'warning', "A parameter's `required` should be `true` or `false` (OKF §10.2)"),
      );
    }
    const name = ctx.pair(item, 'name');
    if (name && isScalar(name.value) && !isEmptyValue(name.value)) {
      const n = String(name.value.value);
      if (seen.has(n)) {
        out.push(ctx.at(rangeOf(name.value, range), 'warning', `Duplicate parameter name \`${n}\` (OKF §10.2)`));
      }
      seen.add(n);
    }
  }
  return out;
};

const computationPath: OkfRule = (ctx) => pathText(ctx, ctx.root, 'computation', 'computation');

/** `executor` / `attester`: a map whose `resource` is a path. */
function endpoint(key: 'executor' | 'attester', example: string): OkfRule {
  return (ctx) => {
    const p = ctx.pair(ctx.root, key);
    if (!p || isEmptyValue(p.value)) return [];
    if (!isMap(p.value)) {
      return [
        ctx.at(pairRange(p, [0, 0]), 'warning', `\`${key}\` should be a map, e.g. \`${example}\` (OKF §10.2)`),
      ];
    }
    return pathText(ctx, p.value, 'resource', `${key}.resource`);
  };
}

const receipt: OkfRule = (ctx) => {
  const e = ctx.pair(ctx.root, 'executor');
  if (!e || !isMap(e.value)) return [];
  const p = ctx.pair(e.value, 'receipt');
  if (!p || isEmptyValue(p.value)) return [];
  const ok = isSeq(p.value) && (p.value.items as Node[]).every((n) => isScalar(n) && !isEmptyValue(n));
  return ok
    ? []
    : [
        ctx.at(
          pairRange(p, [0, 0]),
          'warning',
          '`executor.receipt` should be a list of names, e.g. `[job_id, executed_sql, result]` (OKF §10.2)',
        ),
      ];
};

const RUNTIMES: CompletionOption[] = ['bigquery', 'postgres', 'dbt', 'python', 'Looker'].map((label) => ({
  label,
  detail: 'runtime',
}));

const PARAM_TYPES: CompletionOption[] = ['string', 'integer', 'number', 'boolean', 'date'].map((label) => ({
  label,
  detail: 'type',
  info: 'What a type means follows `runtime` (OKF §10.2).',
}));

export const computation: OkfFamily = {
  id: 'okf-computation',
  keys: ['type'],
  rules: [
    runtimeRequired,
    parameters,
    computationPath,
    endpoint('executor', 'executor: { resource: references/run.md, receipt: [job_id] }'),
    endpoint('attester', 'attester: { resource: references/attest.py }'),
    receipt,
  ].map(forComputation),
  completions: [
    {
      path: ['type'],
      values: [
        {
          label: 'Attested Computation',
          detail: 'OKF §10',
          info: 'A sanctioned way to compute a value: `runtime`, `parameters`, `executor`, `attester`.',
        },
      ],
    },
    {
      path: [],
      keys: [
        { label: 'runtime', detail: 'computation', info: 'How to run an Attested Computation, e.g. `bigquery` (§10.2).' },
        {
          label: 'parameters',
          detail: 'computation',
          info: 'The typed, named holes: a list of `{ name, type, required }` (§10.2).',
        },
        {
          label: 'computation',
          detail: 'computation',
          info: 'A path to the file holding the computation, instead of a `# Computation` fence (§10.3).',
        },
        { label: 'executor', detail: 'computation', info: '`resource` (how to run it) and `receipt` (what a run returns).' },
        { label: 'attester', detail: 'computation', info: '`resource`: deterministic code that checks a receipt (§10.2).' },
      ],
    },
    { path: ['runtime'], values: RUNTIMES },
    {
      path: ['parameters', '*'],
      keys: [
        { label: 'name', detail: 'parameter', info: 'The name the computation binds.' },
        { label: 'type', detail: 'parameter', info: 'Its type; meaning follows `runtime`.' },
        { label: 'required', detail: 'optional', info: '`true` or `false`.' },
      ],
    },
    { path: ['parameters', '*', 'type'], values: PARAM_TYPES },
    {
      path: ['parameters', '*', 'required'],
      values: [{ label: 'true' }, { label: 'false' }],
    },
    {
      path: ['executor'],
      keys: [
        { label: 'resource', detail: 'path', info: `Run instructions or code: ${PATH_HINT}.` },
        { label: 'receipt', detail: 'list', info: 'The names a run must return, e.g. `[job_id, executed_sql, result]`.' },
      ],
    },
    {
      path: ['attester'],
      keys: [{ label: 'resource', detail: 'path', info: `The check (no LLM): ${PATH_HINT}.` }],
    },
  ],
};
