import { describe, expect, test } from 'bun:test';
import { sourceEntrySpan } from './sourceEntry';

const YAML = [
  'type: Metric',
  'sources:',
  '  - id: a',
  '    resource: /a.md',
  '  - resource: all queries in X',
  '  - id: c',
  '    resource: https://c',
  '    title: C',
  'usage_window: { from: 2026-06-01, to: 2026-06-30 }',
].join('\n');

describe('sourceEntrySpan', () => {
  test('finds an entry by list index, caret at its first key', () => {
    const span = sourceEntrySpan(YAML, 2)!;
    expect(YAML.slice(span.from, span.from + 5)).toBe('id: c');
    expect(span.header).toBe(5);
    expect(YAML.slice(span.from, span.to)).toContain('title: C');
    expect(YAML.slice(span.from, span.to)).not.toContain('usage_window');
    expect(span.siblings).toEqual([2, 4]);
  });

  test('a one-line entry', () => {
    const span = sourceEntrySpan(YAML, 1)!;
    expect(YAML.slice(span.from, span.to).trim()).toBe('resource: all queries in X');
    expect(span.siblings).toEqual([2, 5]);
  });

  test('the compact form (`sources:` over a same-indent list)', () => {
    const yaml = 'sources:\n- id: a\n  resource: /a.md\n- id: b\n  resource: /b.md\n';
    const span = sourceEntrySpan(yaml, 1)!;
    expect(span.header).toBe(3);
    expect(yaml.slice(span.from, span.from + 5)).toBe('id: b');
  });

  test('no such entry, no sources list, or unparseable YAML', () => {
    expect(sourceEntrySpan(YAML, 3)).toBeNull();
    expect(sourceEntrySpan('type: x\n', 0)).toBeNull();
    expect(sourceEntrySpan('sources: 3\n', 0)).toBeNull();
    expect(sourceEntrySpan('sources: [\n', 0)).toBeNull();
  });
});
