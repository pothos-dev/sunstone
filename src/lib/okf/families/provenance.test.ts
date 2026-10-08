import { describe, expect, test } from 'bun:test';
import { lintFrontmatter } from '../lint';
import { completeFrontmatter } from '../complete';
import { provenance } from './provenance';

/** Provenance findings as `[severity, marked text]`. */
function marks(yaml: string) {
  return lintFrontmatter(yaml, 'okf', [provenance]).map((f) => [f.severity, yaml.slice(f.from, f.to)]);
}

const lines = (...ls: string[]) => ls.join('\n') + '\n';

describe('provenance lint (§5.1)', () => {
  test('the spec example is clean', () => {
    const yaml = lines(
      'type: Metric',
      'sources:',
      '  - id: ga4-schema',
      '    resource: https://developers.google.com/analytics/bigquery/export-schema',
      '    title: GA4 BigQuery Export schema',
      '    author: team:ga4-docs',
      '    usage_count: 5000',
      '    last_modified: 2026-05-30T00:00:00Z',
      '  - resource: all queries in BigQuery project X',
      '  - resource: references/skills/run.md',
      'usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }',
    );
    expect(marks(yaml)).toEqual([]);
  });

  test('`sources` must be a list of maps, `resource` required in each', () => {
    expect(marks('sources: https://x\n')).toEqual([['warning', 'sources: https://x']]);
    expect(marks(lines('sources:', '  - https://x', '  - resource: /a.md'))).toEqual([
      ['warning', 'https://x'],
    ]);
    expect(marks(lines('sources:', '  - id: a'))).toEqual([['error', 'id: a']]);
    // Empty is absence, never a finding.
    expect(marks('sources:\n')).toEqual([]);
    expect(marks('sources: []\n')).toEqual([]);
  });

  test('text fields that are lists or maps', () => {
    expect(marks(lines('sources:', '  - resource: [a, b]', '    title: { x: 1 }'))).toEqual([
      ['warning', 'resource: [a, b]'],
      ['warning', 'title: { x: 1 }'],
    ]);
  });

  test('a repeated id (case-insensitively) is a warning at the repeat', () => {
    const yaml = lines('sources:', '  - { id: a, resource: /a.md }', '  - { id: A, resource: /b.md }');
    expect(marks(yaml)).toEqual([['warning', 'A']]);
  });

  test('usage_count is a whole number', () => {
    const yaml = lines(
      'sources:',
      '  - { resource: x, usage_count: lots }',
      '  - { resource: y, usage_count: -1 }',
      '  - { resource: z, usage_count: 2.5 }',
      '  - { resource: w, usage_count: 0 }',
      'usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }',
    );
    expect(marks(yaml)).toEqual([
      ['warning', 'usage_count: lots'],
      ['warning', 'usage_count: -1'],
      ['warning', 'usage_count: 2.5'],
    ]);
  });

  test('usage_window is a `{ from, to }` of ISO datetimes, in order', () => {
    expect(marks(lines('sources: []', 'usage_window: last month'))).toEqual([['warning', 'last month']]);
    expect(marks('usage_window: { from: 2026-06-01, to: 2026-06-30T00:00:00Z }\n')).toEqual([
      ['warning', '2026-06-01'],
    ]);
    expect(
      marks('usage_window: { from: 2026-07-01T00:00:00Z, to: 2026-06-30T00:00:00+02:00 }\n'),
    ).toEqual([['warning', '{ from: 2026-07-01T00:00:00Z, to: 2026-06-30T00:00:00+02:00 }']]);
    // Per-entry override, checked the same way.
    const entry = lines('sources:', '  - resource: x', '    usage_window: { to: yesterday }');
    expect(marks(entry)).toEqual([['warning', 'yesterday']]);
  });

  test('last_modified is an ISO datetime', () => {
    expect(marks(lines('sources:', '  - { resource: x, last_modified: May 2026 }'))).toEqual([
      ['warning', 'May 2026'],
    ]);
  });

  test('a usage_count with no window anywhere is info; either window frames it', () => {
    const bare = lines('sources:', '  - resource: x', '    usage_count: 5');
    expect(marks(bare)).toEqual([['info', 'usage_count']]);
    const own = bare + '    usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }\n';
    expect(marks(own)).toEqual([]);
    const shared = bare + 'usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }\n';
    expect(marks(shared)).toEqual([]);
  });

  test('no sources and no usage_window: the family does not run', () => {
    expect(marks('type: x\n')).toEqual([]);
  });
});

describe('provenance completion', () => {
  test('`author` values start an actor', () => {
    const yaml = 'type: x\nsources:\n  - resource: y\n    author: ';
    const r = completeFrontmatter(yaml, yaml.length, 'okf', [provenance]);
    expect(r?.options.map((o) => o.label)).toEqual(['human:', 'process:']);
  });

  test('`sources` is offered at the top level', () => {
    const r = completeFrontmatter('type: x\n', 8, 'okf', [provenance]);
    expect(r?.options.map((o) => o.label)).toContain('sources');
  });
});
