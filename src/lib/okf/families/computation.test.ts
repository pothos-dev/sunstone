import { describe, expect, test } from 'bun:test';
import { lintFrontmatter } from '../lint';
import { completeFrontmatter } from '../complete';
import { OKF_FAMILIES } from './index';
import { computation } from './computation';

/** Computation findings as `[severity, marked text]`. */
function marks(yaml: string) {
  return lintFrontmatter(yaml, 'okf', [computation]).map((f) => [f.severity, yaml.slice(f.from, f.to)]);
}

const lines = (...ls: string[]) => ls.join('\n') + '\n';
const AC = 'type: Attested Computation';

describe('computation lint (§10.2)', () => {
  test('the spec example is clean', () => {
    const yaml = lines(
      AC,
      'title: Revenue for fiscal year',
      'runtime: bigquery',
      'parameters:',
      '  - { name: year, type: integer, required: true }',
      'executor:',
      '  resource: references/skills/run-on-bq.md',
      '  receipt: [job_id, executed_sql, result]',
      'attester:',
      '  resource: references/attesters/revenue.py',
    );
    expect(marks(yaml)).toEqual([]);
    // And with the whole language service, not just this family.
    expect(lintFrontmatter(yaml, 'okf', OKF_FAMILIES)).toEqual([]);
  });

  test('`runtime` is REQUIRED for the type: an error, on `type` when missing', () => {
    expect(marks(lines(AC))).toEqual([['error', 'type']]);
    expect(marks(lines(AC, 'runtime:'))).toEqual([['error', 'runtime:']]);
    expect(marks(lines(AC, 'runtime: [a]'))).toEqual([['warning', 'runtime: [a]']]);
  });

  test('missing optional contract keys are never findings', () => {
    expect(marks(lines(AC, 'runtime: python'))).toEqual([]);
    expect(marks(lines(AC, 'runtime: python', 'parameters:', 'executor:', 'attester:', 'computation:'))).toEqual([]);
    expect(marks(lines(AC, 'runtime: python', 'parameters: []', 'executor: {}', 'attester: {}'))).toEqual([]);
  });

  test('another type is left alone, whatever its keys', () => {
    expect(marks(lines('type: Metric', 'runtime: [a]', 'parameters: 3', 'executor: x'))).toEqual([]);
    expect(marks(lines('title: no type', 'parameters: 3'))).toEqual([]);
  });

  test('`parameters`: a list of maps with `name` and `type`, `required` optional', () => {
    expect(marks(lines(AC, 'runtime: python', 'parameters: year'))).toEqual([['warning', 'parameters: year']]);
    expect(
      marks(
        lines(
          AC,
          'runtime: python',
          'parameters:',
          '  - name: year',
          '    type: integer',
          '  - year',
          '  - { name: a }',
          '  - { type: date }',
          '  - { name: [x], type: date, required: yes please }',
          '  - { name: year, type: integer, required: false }',
        ),
      ),
    ).toEqual([
      ['warning', 'year'],
      ['warning', '{ name: a }'],
      ['warning', '{ type: date }'],
      ['warning', 'name: [x]'],
      ['warning', 'required: yes please'],
      ['warning', 'year'],
    ]);
  });

  test('path-valued fields are text', () => {
    expect(
      marks(
        lines(
          AC,
          'runtime: python',
          'computation: [a.sql]',
          'executor: { resource: { x: 1 } }',
          'attester: { resource: references/attest.py }',
        ),
      ),
    ).toEqual([
      ['warning', 'computation: [a.sql]'],
      ['warning', 'resource: { x: 1 }'],
    ]);
  });

  test('`executor` and `attester` are maps; `receipt` a list of names', () => {
    expect(marks(lines(AC, 'runtime: python', 'executor: run.md', 'attester: a.py'))).toEqual([
      ['warning', 'executor: run.md'],
      ['warning', 'attester: a.py'],
    ]);
    expect(marks(lines(AC, 'runtime: python', 'executor:', '  receipt: job_id'))).toEqual([
      ['warning', 'receipt: job_id'],
    ]);
    expect(marks(lines(AC, 'runtime: python', 'executor:', '  receipt: [job_id, { a: 1 }]'))).toEqual([
      ['warning', 'receipt: [job_id, { a: 1 }]'],
    ]);
    expect(marks(lines(AC, 'runtime: python', 'executor:', '  receipt:', '    - job_id', '    - result'))).toEqual(
      [],
    );
  });
});

describe('computation completion', () => {
  function labelsAt(text: string) {
    const pos = text.indexOf('|');
    const yaml = text.slice(0, pos) + text.slice(pos + 1);
    return completeFrontmatter(yaml, pos, 'okf')?.options.map((o) => o.label) ?? null;
  }

  test('`type` offers Attested Computation; the contract keys are offered at the top level', () => {
    expect(labelsAt('type: |')).toContain('Attested Computation');
    const top = labelsAt(`${AC}\n|`)!;
    for (const k of ['runtime', 'parameters', 'computation', 'executor', 'attester']) expect(top).toContain(k);
  });

  test('runtime values, parameter keys and values, executor and attester keys', () => {
    expect(labelsAt(`${AC}\nruntime: |`)).toEqual(['bigquery', 'postgres', 'dbt', 'python', 'Looker']);
    expect(labelsAt(`${AC}\nparameters:\n  - |`)).toEqual(['name', 'type', 'required']);
    expect(labelsAt(`${AC}\nparameters:\n  - name: year\n    |`)).toEqual(['type', 'required']);
    expect(labelsAt(`${AC}\nparameters:\n  - name: year\n    required: |`)).toEqual(['true', 'false']);
    expect(labelsAt(`${AC}\nexecutor:\n  |`)).toEqual(['resource', 'receipt']);
    expect(labelsAt(`${AC}\nattester:\n  |`)).toEqual(['resource']);
  });
});
