// Computation family (§10): the contract of an Attested Computation (ov-12).
//
// Lint (`sunstone_shared::okf_lint`, family `okf-computation`), only on a
// Concept whose `type` is `Attested Computation`: `runtime` is REQUIRED (an
// error); the shapes of `parameters`, `computation`, `executor` and `attester`
// are warnings. Nothing runs or verifies the computation.

import type { CompletionOption, OkfFamily } from '../family';

const PATH_HINT = 'a URL, a bundle path (`/…`) or a relative path (OKF §6.2)';

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
