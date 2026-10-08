import { describe, expect, test } from 'bun:test';
import { contractOf, isAttestedComputation } from '$lib/wasm/exports';
import { contractCardHtml } from './computation';

// The Attested Computation contract card. The native render's
// `render/computation.rs` asserts the same goldens (with its own link
// attributes), so the desktop editor, the fake and the web viewer agree.

const REVENUE = `type: Attested Computation
title: Revenue for fiscal year
runtime: bigquery
parameters:
  - { name: year, type: integer, required: true }
executor:
  resource: references/skills/run-on-bq.md
  receipt: [job_id, executed_sql, result]
attester:
  resource: references/attesters/revenue.py
`;

describe('contractOf (shared Rust over wasm)', () => {
  test('reads the §10.2 contract', () => {
    expect(contractOf(REVENUE)).toEqual({
      runtime: 'bigquery',
      parameters: [{ name: 'year', type: 'integer', required: true }],
      computation: null,
      executor: {
        resource: { value: 'references/skills/run-on-bq.md', kind: 'path' },
        receipt: ['job_id', 'executed_sql', 'result'],
      },
      attester: { resource: { value: 'references/attesters/revenue.py', kind: 'path' } },
    } as never);
  });

  test('only an Attested Computation has one', () => {
    expect(contractOf('type: Metric\nruntime: bigquery\n')).toBeNull();
    expect(isAttestedComputation(REVENUE)).toBe(true);
    expect(isAttestedComputation('type: Metric\n')).toBe(false);
  });

  test('a path-valued computation, and a URL', () => {
    const c = contractOf(
      'type: Attested Computation\ncomputation: /references/computations/lib/revenue.sql\nattester: { resource: https://x.example/a.py }\n',
    )!;
    expect(c.computation).toEqual({ value: '/references/computations/lib/revenue.sql', kind: 'path' });
    expect(c.attester?.resource).toEqual({ value: 'https://x.example/a.py', kind: 'url' });
  });
});

describe('contractCardHtml', () => {
  test('the §10.2 example (golden, shared with render/computation.rs)', () => {
    expect(contractCardHtml(REVENUE)).toBe(
      '<section class="computation" data-testid="computation">' +
        '<div class="computation-heading" title="OKF §10: the sanctioned way to compute this value. Shown only: Sunstone does not run or verify it.">Attested Computation</div>' +
        '<dl class="computation-fields">' +
        '<dt>Runtime</dt><dd><code class="computation-runtime">bigquery</code></dd>' +
        '<dt>Parameters</dt><dd><ul class="computation-params"><li><code class="computation-param-name">year</code> <span class="computation-param-type">integer</span> <span class="computation-param-required">required</span></li></ul></dd>' +
        '<dt>Executor</dt><dd><a data-resource="references/skills/run-on-bq.md" href="references/skills/run-on-bq.md">references/skills/run-on-bq.md</a> <span class="computation-receipt"><span class="computation-label">Receipt</span> <code>job_id</code> <code>executed_sql</code> <code>result</code></span></dd>' +
        '<dt>Attester</dt><dd><a data-resource="references/attesters/revenue.py" href="references/attesters/revenue.py">references/attesters/revenue.py</a></dd>' +
        '</dl></section>',
    );
  });

  test('parameters: required optional, a missing name says so', () => {
    const html = contractCardHtml(
      'type: Attested Computation\nparameters:\n  - { name: a, type: string }\n  - { name: b, type: date, required: false }\n  - { type: integer }\n',
    );
    expect(html).toContain(
      '<ul class="computation-params"><li><code class="computation-param-name">a</code> <span class="computation-param-type">string</span></li>' +
        '<li><code class="computation-param-name">b</code> <span class="computation-param-type">date</span> <span class="computation-param-optional">optional</span></li>' +
        '<li><span class="computation-missing">unnamed</span> <span class="computation-param-type">integer</span></li></ul>',
    );
  });

  test('missing contract keys are not shown, and nothing at all means no card', () => {
    expect(contractCardHtml('type: Attested Computation\n')).toBe('');
    expect(contractCardHtml('type: Attested Computation\nexecutor: {}\nattester: {}\n')).toBe('');
    const html = contractCardHtml('type: Attested Computation\nruntime: python\n');
    expect(html).toContain('<dt>Runtime</dt>');
    expect(html).not.toContain('<dt>Parameters</dt>');
    expect(html).not.toContain('<dt>Executor</dt>');
  });

  test('another type gets no card, even with contract keys', () => {
    expect(contractCardHtml('type: Metric\nruntime: bigquery\n')).toBe('');
  });

  test('values are escaped and links take the given attributes', () => {
    const html = contractCardHtml(
      'type: Attested Computation\nruntime: "<b>"\ncomputation: \'a"b.sql\'\n',
      (v) => `class="internal-link" data-path="${v.length}"`,
    );
    expect(html).toContain('<code class="computation-runtime">&lt;b&gt;</code>');
    expect(html).toContain('<a data-resource="a&quot;b.sql" class="internal-link" data-path="7">a&quot;b.sql</a>');
  });
});
