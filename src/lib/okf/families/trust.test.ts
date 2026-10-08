import { describe, expect, test } from 'bun:test';
import { lintFrontmatter } from '../lint';
import { completeFrontmatter } from '../complete';
import { isoNow } from './trust';

/** Trust findings as `[severity, marked text]`. */
function trustMarks(yaml: string, mode: 'yaml' | 'okf' = 'okf') {
  return lintFrontmatter(yaml, mode)
    .filter((f) => f.source === 'okf-trust')
    .map((f) => [f.severity, yaml.slice(f.from, f.to)]);
}

function valuesAt(marked: string): string[] | null {
  const pos = marked.indexOf('|');
  const yaml = marked.slice(0, pos) + marked.slice(pos + 1);
  return completeFrontmatter(yaml, pos, 'okf')?.options.map((o) => o.label) ?? null;
}

describe('trust lint (ov-9)', () => {
  test('generated without by is an error; a non-ISO at is a warning', () => {
    expect(trustMarks('type: x\ngenerated:\n  at: 2026-06-20\n')).toEqual([
      ['error', 'generated'],
      ['warning', 'at: 2026-06-20'],
    ]);
  });

  test('an at without a UTC offset, or not a string, is a warning', () => {
    expect(trustMarks('type: x\ngenerated: { by: a/1, at: 2026-06-20T10:00:00 }\n')).toEqual([
      ['warning', 'at: 2026-06-20T10:00:00'],
    ]);
    expect(trustMarks('type: x\ngenerated: { by: a/1, at: 2026 }\n')).toEqual([['warning', 'at: 2026']]);
    expect(lintFrontmatter('type: x\ngenerated: { by: a/1, at: 2026 }\n', 'okf')[0].message).toContain(
      'ISO 8601',
    );
  });

  test('verified events: each at is checked, in list and bare form', () => {
    expect(
      trustMarks('type: x\nverified:\n  - { by: human:a, at: 2026-06-25T09:00:00Z }\n  - { by: process:p, at: monday }\n'),
    ).toEqual([['warning', 'at: monday']]);
    expect(trustMarks('type: x\nverified: { by: human:a, at: monday }\n')).toEqual([['warning', 'at: monday']]);
  });

  test('a bare verified mapping is legal', () => {
    expect(trustMarks('type: x\nverified: { by: human:a, at: 2026-06-25T09:00:00Z }\n')).toEqual([]);
    expect(trustMarks('type: x\nverified:\n  by: human:a\n  at: 2026-06-25T09:00:00+02:00\n')).toEqual([]);
  });

  test('verification events should say who and when', () => {
    expect(trustMarks('type: x\nverified:\n  - { at: 2026-06-25T09:00:00Z }\n  - by: human:a\n')).toEqual([
      ['warning', '{ at: 2026-06-25T09:00:00Z }'],
      ['warning', 'by: human:a'],
    ]);
  });

  test('wrong shapes are warnings, never errors', () => {
    expect(trustMarks('type: x\ngenerated: agent/1\n')).toEqual([['warning', 'generated: agent/1']]);
    expect(trustMarks('type: x\nverified: human:a\n')).toEqual([['warning', 'verified: human:a']]);
    expect(trustMarks('type: x\nverified:\n  - human:a\n')).toEqual([['warning', 'human:a']]);
  });

  test('a complete trust block is clean', () => {
    const yaml =
      'type: x\ngenerated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-20T22:53:05Z }\n' +
      'verified:\n  - { by: human:ahormati, at: 2026-06-25T09:00:00Z }\n  - { by: process:nightly, at: 2026-06-26T02:00:00-05:00 }\n';
    expect(lintFrontmatter(yaml, 'okf')).toEqual([]);
  });

  test('none of it in a non-OKF Bundle', () => {
    expect(lintFrontmatter('generated:\n  at: whenever\nverified: nope\n', 'yaml')).toEqual([]);
  });

  test('a Concept with none of the keys gets no trust findings', () => {
    expect(trustMarks('type: x\ntimestamp: 2026-06-15\n')).toEqual([]);
  });
});

describe('trust completion (ov-9)', () => {
  test('generated, not timestamp, is offered for a new Concept', () => {
    const labels = valuesAt('type: x\n|')!;
    expect(labels).toContain('generated');
    expect(labels).not.toContain('timestamp');
  });

  test('an at value offers now, ISO 8601 in UTC', () => {
    const [now] = valuesAt('generated:\n  at: |')!;
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(valuesAt('verified:\n  - by: human:a\n    at: |')).toHaveLength(1);
    expect(valuesAt('verified:\n  - at: |')).toHaveLength(1);
  });

  test('a by value offers the actor prefixes', () => {
    expect(valuesAt('generated:\n  by: |')).toEqual(['human:', 'process:']);
    expect(valuesAt('verified:\n  - by: |')).toEqual(['human:', 'process:']);
  });

  test('a new verification event gets by/at', () => {
    expect(valuesAt('verified:\n  - by: human:a\n    at: 2026-06-25T09:00:00Z\n  - |')).toEqual(['by', 'at']);
  });

  test('isoNow drops the milliseconds and keeps the Z', () => {
    expect(isoNow(new Date('2026-06-30T14:00:00.123Z'))).toBe('2026-06-30T14:00:00Z');
  });
});
