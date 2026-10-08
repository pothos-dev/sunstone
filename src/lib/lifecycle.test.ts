import { describe, expect, test } from 'bun:test';
import { isStale, lifecycleFromFields, lifecycleFromYaml, lifecycleOfNode, lifecycleView } from './lifecycle';

const AT = '2026-09-23T00:00:00Z';
const AT_MS = Date.UTC(2026, 8, 23);

describe('isStale: the §5.5 boundary (now >= stale_after)', () => {
  test('before the instant: not stale', () => {
    expect(isStale(AT, AT_MS - 1)).toBe(false);
  });

  test('exactly at the instant: stale', () => {
    expect(isStale(AT, AT_MS)).toBe(true);
    expect(isStale(AT, new Date(AT_MS))).toBe(true);
  });

  test('after the instant: stale', () => {
    expect(isStale(AT, AT_MS + 1)).toBe(true);
  });

  test('a malformed date is never stale', () => {
    expect(isStale('next tuesday', AT_MS)).toBe(false);
    expect(isStale('2026-02-30T00:00:00Z', Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  test('absent is never stale', () => {
    expect(isStale(null, AT_MS)).toBe(false);
    expect(isStale(undefined, AT_MS)).toBe(false);
  });

  test('a value without an offset is read as UTC', () => {
    expect(isStale('2026-09-23T00:00:00', AT_MS)).toBe(true);
    expect(isStale('2026-09-23T00:00:00', AT_MS - 1)).toBe(false);
  });
});

describe('lifecycleFromYaml', () => {
  test('neither key: null', () => {
    expect(lifecycleFromYaml('')).toBeNull();
    expect(lifecycleFromYaml('type: x\ntitle: y\n')).toBeNull();
  });

  test('reads both keys as raw strings', () => {
    expect(lifecycleFromYaml(`type: x\nstatus: draft\nstale_after: ${AT}\n`)).toEqual({
      status: 'draft',
      staleAfter: AT,
    });
    expect(lifecycleFromYaml('status: deprecated')).toEqual({ status: 'deprecated', staleAfter: null });
    expect(lifecycleFromYaml(`stale_after: "${AT}"`)).toEqual({ status: null, staleAfter: AT });
  });

  test('empty or non-scalar values count as absent', () => {
    expect(lifecycleFromYaml('status:\nstale_after: ""\n')).toBeNull();
    expect(lifecycleFromYaml('status: [a, b]\n')).toBeNull();
  });

  test('an unparseable block: null', () => {
    expect(lifecycleFromYaml('status: [draft\n')).toBeNull();
  });
});

describe('lifecycleFromFields (the server-rendered Frontmatter)', () => {
  test('picks the two keys out of the field list', () => {
    expect(
      lifecycleFromFields([
        { key: 'type', values: ['x'] },
        { key: 'status', values: ['draft'] },
        { key: 'stale_after', values: [AT] },
      ]),
    ).toEqual({ status: 'draft', staleAfter: AT });
    expect(lifecycleFromFields([{ key: 'type', values: ['x'] }])).toBeNull();
    expect(lifecycleFromFields([{ key: 'status', values: ['a', 'b'] }])).toBeNull();
  });
});

describe('lifecycleView', () => {
  test('neither key: no affordance at all', () => {
    expect(lifecycleView(null, AT_MS)).toBeNull();
    expect(lifecycleView({ status: null, staleAfter: null }, AT_MS)).toBeNull();
  });

  test('a recognised status shows; stale_after in the future shows nothing extra', () => {
    expect(lifecycleView({ status: 'draft', staleAfter: AT }, AT_MS - 1)).toEqual({
      status: 'draft',
      stale: false,
      title: `Draft: not yet reviewed; possibly incomplete. Stale after ${AT}.`,
    });
  });

  test('past stale_after: marked stale, status or not', () => {
    expect(lifecycleView({ status: null, staleAfter: AT }, AT_MS)).toEqual({
      status: null,
      stale: true,
      title: `Stale since ${AT}: treat as possibly out of date.`,
    });
    expect(lifecycleView({ status: 'stable', staleAfter: AT }, AT_MS)?.stale).toBe(true);
  });

  test('a not-yet-stale stale_after alone shows nothing', () => {
    expect(lifecycleView({ status: null, staleAfter: AT }, AT_MS - 1)).toBeNull();
  });

  test('a malformed stale_after alone shows nothing (lint flags it)', () => {
    expect(lifecycleView({ status: null, staleAfter: 'soon' }, AT_MS)).toBeNull();
  });

  test('an unrecognised status shows nothing (lint flags it)', () => {
    expect(lifecycleView({ status: 'wip', staleAfter: null }, AT_MS)).toBeNull();
    expect(lifecycleView({ status: 'Draft', staleAfter: null }, AT_MS)).toBeNull();
  });

  test('an offset-less value displays as written', () => {
    const v = lifecycleView({ status: null, staleAfter: '2026-09-23' }, AT_MS)!;
    expect(v.stale).toBe(true);
    expect(v.title).toContain('2026-09-23');
  });
});

describe('lifecycleView: compact (Explorer rows)', () => {
  test('the default `stable` stays quiet; draft, deprecated and stale show', () => {
    expect(lifecycleView({ status: 'stable', staleAfter: null }, AT_MS, { compact: true })).toBeNull();
    expect(lifecycleView({ status: 'stable', staleAfter: AT }, AT_MS, { compact: true })).toMatchObject({
      status: null,
      stale: true,
    });
    expect(lifecycleView({ status: 'draft', staleAfter: null }, AT_MS, { compact: true })?.status).toBe('draft');
    expect(lifecycleView({ status: 'deprecated', staleAfter: null }, AT_MS, { compact: true })?.status).toBe(
      'deprecated',
    );
  });
});

describe('lifecycleOfNode (Explorer tree nodes)', () => {
  test('reads the raw keys the walker carries', () => {
    expect(lifecycleOfNode({ name: 'a.md', path: 'a.md', isDir: false })).toBeNull();
    expect(lifecycleOfNode({ name: 'a.md', path: 'a.md', isDir: false, staleAfter: AT })).toEqual({
      status: null,
      staleAfter: AT,
    });
  });
});
