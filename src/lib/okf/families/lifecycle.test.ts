import { describe, expect, test } from 'bun:test';
import { lintFrontmatter } from '../lint';
import { completeFrontmatter } from '../complete';
import { parseInstant } from '$lib/instant';

/** Lifecycle findings as `[severity, marked text]`. */
function marks(yaml: string, mode: 'yaml' | 'okf' = 'okf') {
  return lintFrontmatter(yaml, mode)
    .filter((f) => f.source === 'okf-lifecycle')
    .map((f) => [f.severity, yaml.slice(f.from, f.to)]);
}

/** Value completion at the end of `yaml`. */
function valuesAt(yaml: string, mode: 'yaml' | 'okf' = 'okf') {
  return completeFrontmatter(yaml, yaml.length, mode);
}

describe('lifecycle lint: status (§5.4)', () => {
  test('the three values are clean', () => {
    for (const s of ['draft', 'stable', 'deprecated']) expect(marks(`type: x\nstatus: ${s}\n`)).toEqual([]);
  });

  test('anything else is an error at the value', () => {
    expect(marks('type: x\nstatus: wip\n')).toEqual([['error', 'wip']]);
    expect(marks('type: x\nstatus: Draft\n')).toEqual([['error', 'Draft']]);
    expect(marks('type: x\nstatus: 3\n')).toEqual([['error', '3']]);
    expect(marks('type: x\nstatus: [draft]\n')).toEqual([['error', '[draft]']]);
    expect(lintFrontmatter('type: x\nstatus: wip\n', 'okf')[0].message).toContain('draft');
  });

  test('an empty status is outside the enum too', () => {
    expect(marks('type: x\nstatus:\n')).toEqual([['error', 'status:']]);
  });

  test('nothing in a non-OKF Bundle', () => {
    expect(lintFrontmatter('status: wip\nstale_after: soon\n', 'yaml')).toEqual([]);
  });
});

describe('lifecycle lint: stale_after (§5.5)', () => {
  test('an ISO 8601 instant with an offset is clean', () => {
    expect(marks('type: x\nstale_after: 2026-09-23T00:00:00Z\n')).toEqual([]);
    expect(marks('type: x\nstale_after: "2026-09-23T02:00:00+02:00"\n')).toEqual([]);
  });

  test('no UTC offset: a warning, not an error', () => {
    expect(marks('type: x\nstale_after: 2026-09-23T00:00:00\n')).toEqual([['warning', '2026-09-23T00:00:00']]);
    expect(marks('type: x\nstale_after: 2026-09-23\n')).toEqual([['warning', '2026-09-23']]);
    expect(lintFrontmatter('stale_after: 2026-09-23\n', 'okf').find((f) => f.source === 'okf-lifecycle')?.message).toContain(
      'offset',
    );
  });

  test('not a date at all: a warning', () => {
    expect(marks('type: x\nstale_after: next week\n')).toEqual([['warning', 'next week']]);
    expect(marks('type: x\nstale_after: 2026\n')).toEqual([['warning', '2026']]);
    expect(marks('type: x\nstale_after:\n')).toEqual([['warning', 'stale_after:']]);
  });

  test('a past stale_after is not a lint finding (staleness is advisory)', () => {
    expect(marks('type: x\nstale_after: 2000-01-01T00:00:00Z\n')).toEqual([]);
  });
});

describe('lifecycle completion', () => {
  test('status offers the three values', () => {
    const r = valuesAt('type: x\nstatus: ')!;
    expect(r.kind).toBe('value');
    expect(r.options.map((o) => o.label)).toEqual(['draft', 'stable', 'deprecated']);
  });

  test('stale_after offers ISO 8601 instants with a Z offset, in the future', () => {
    const before = Date.now();
    const r = valuesAt('type: x\nstale_after: ')!;
    expect(r.options.length).toBeGreaterThan(0);
    for (const o of r.options) {
      const text = o.apply ?? o.label;
      expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(parseInstant(text)!).toBeGreaterThan(before);
    }
  });

  test('none in a non-OKF Bundle', () => {
    expect(valuesAt('status: ', 'yaml')).toBeNull();
  });
});
