import { describe, expect, test } from 'bun:test';
import { lintFrontmatter } from './lint';
import { isParseable } from '$lib/frontmatter';
import type { OkfFamily } from './family';

/** Findings as `[severity, marked text, source]`, for compact assertions. */
function marks(yaml: string, mode: 'yaml' | 'okf', families?: OkfFamily[]) {
  return lintFrontmatter(yaml, mode, families).map((f) => [f.severity, yaml.slice(f.from, f.to), f.source]);
}

describe('lintFrontmatter: well-formedness (every Bundle)', () => {
  test('a well-formed block has no findings in yaml mode', () => {
    expect(lintFrontmatter('title: x\ntags: [a]\n', 'yaml')).toEqual([]);
  });

  test('yaml mode says nothing about OKF, even with no type', () => {
    expect(lintFrontmatter('', 'yaml')).toEqual([]);
    expect(lintFrontmatter('sources:\n  - id: x\n', 'yaml')).toEqual([]);
  });

  test('malformed YAML is an error with a position, in both modes', () => {
    for (const mode of ['yaml', 'okf'] as const) {
      const yaml = 'type: a\ntags: [a, b\n';
      const findings = lintFrontmatter(yaml, mode);
      expect(findings.length).toBeGreaterThan(0);
      for (const f of findings) {
        expect(f.severity).toBe('error');
        expect(f.source).toBe('yaml');
        expect(f.from).toBeGreaterThanOrEqual(0);
        expect(f.to).toBeLessThanOrEqual(yaml.length);
        expect(f.message).not.toContain('\n');
      }
    }
  });

  test('a malformed block gets no OKF findings on top of its parse error', () => {
    const findings = lintFrontmatter('title: [x\n', 'okf');
    expect(findings.every((f) => f.source === 'yaml')).toBe(true);
  });

  test('a duplicate key is reported at the key, top-level and nested, in both modes', () => {
    const yaml = 'type: a\ntitle: x\ntype: b\ngenerated:\n  by: x\n  by: y\n';
    for (const mode of ['yaml', 'okf'] as const) {
      expect(marks(yaml, mode)).toEqual([
        ['error', 'type', 'yaml'],
        ['error', 'by', 'yaml'],
      ]);
    }
    expect(lintFrontmatter(yaml, 'yaml')[0].message).toBe('Duplicate key `type`');
  });

  test('the save gate ignores the lint: a duplicate key or an OKF error still parses', () => {
    expect(isParseable('type: a\ntype: b\n')).toBe(true);
    expect(lintFrontmatter('type: a\ntype: b\n', 'okf').length).toBeGreaterThan(0);
    expect(isParseable('title: no type\nsources:\n  - id: x\n')).toBe(true);
    expect(lintFrontmatter('title: no type\nsources:\n  - id: x\n', 'okf').length).toBeGreaterThan(0);
  });
});

describe('lintFrontmatter: OKF core (§4.1)', () => {
  test('a Concept with just a type is clean', () => {
    expect(lintFrontmatter('type: Metric\n', 'okf')).toEqual([]);
  });

  test('a missing type is an error on the first line', () => {
    expect(marks('title: Revenue\ndescription: d\n', 'okf')).toEqual([['error', 'title: Revenue', 'okf']]);
    expect(lintFrontmatter('title: Revenue\n', 'okf')[0].message).toContain('`type`');
  });

  test('an empty block still owes a type', () => {
    const [f] = lintFrontmatter('', 'okf');
    expect(f).toMatchObject({ from: 0, to: 0, severity: 'error' });
  });

  test('an empty type (the scaffold stub) is an error at the entry', () => {
    expect(marks('type:\ntitle: x\n', 'okf')).toEqual([['error', 'type:', 'okf']]);
    expect(marks("type: ''\n", 'okf')).toEqual([['error', "type: ''", 'okf']]);
  });

  test('a non-mapping block is an error', () => {
    expect(marks('- a\n- b\n', 'okf')).toEqual([['error', '- a\n- b\n', 'okf']]);
  });

  test('wrongly typed recommended keys are warnings, not errors', () => {
    const yaml = 'type: x\ntitle: 1984\ndescription: [a]\ntags: solo\n';
    expect(marks(yaml, 'okf')).toEqual([
      ['warning', 'title: 1984', 'okf'],
      ['warning', 'description: [a]', 'okf'],
      ['warning', 'tags: solo', 'okf'],
    ]);
  });

  test('tags as a flow or block list of strings is fine', () => {
    expect(lintFrontmatter('type: x\ntags: [a, b]\n', 'okf')).toEqual([]);
    expect(lintFrontmatter('type: x\ntags:\n  - a\n  - b\n', 'okf')).toEqual([]);
  });

  test('unknown keys are never reported (§4.1 extensions)', () => {
    expect(lintFrontmatter('type: x\nowner: team-a\nnested: { a: 1 }\n', 'okf')).toEqual([]);
  });
});

describe('lintFrontmatter: REQUIRED family fields are errors', () => {
  test('a sources entry without resource', () => {
    const yaml = 'type: x\nsources:\n  - id: ga4\n    title: GA4\n  - resource: https://x\n';
    expect(marks(yaml, 'okf')).toEqual([['error', 'id: ga4', 'okf-provenance']]);
    expect(lintFrontmatter(yaml, 'okf')[0].message).toContain('`sources[]`');
  });

  test('a flow-style sources entry without resource', () => {
    expect(marks('type: x\nsources: [{ id: a }]\n', 'okf')).toEqual([['error', '{ id: a }', 'okf-provenance']]);
  });

  test('generated without by, in block and flow form', () => {
    expect(marks('type: x\ngenerated:\n  at: 2026-01-01T00:00:00Z\n', 'okf')).toEqual([
      ['error', 'generated', 'okf-trust'],
    ]);
    expect(marks('type: x\ngenerated: { at: 2026-01-01T00:00:00Z }\n', 'okf')).toEqual([
      ['error', 'generated', 'okf-trust'],
    ]);
    expect(marks('type: x\ngenerated:\n', 'okf')).toEqual([['error', 'generated', 'okf-trust']]);
  });

  test('an empty generated.by is an error at the entry', () => {
    expect(marks('type: x\ngenerated: { by: "", at: 2026-01-01T00:00:00Z }\n', 'okf')).toEqual([
      ['error', 'by: ""', 'okf-trust'],
    ]);
  });

  test('complete families are clean', () => {
    const yaml = [
      'type: Metric',
      'sources:',
      '  - id: a',
      '    resource: https://example.com',
      'generated: { by: agent:x, at: 2026-06-20T22:53:05Z }',
      'verified:',
      '  - { by: human:a, at: 2026-06-25T09:00:00Z }',
      'status: stable',
      '',
    ].join('\n');
    expect(lintFrontmatter(yaml, 'okf')).toEqual([]);
  });

  test('none of this in yaml mode', () => {
    expect(lintFrontmatter('sources:\n  - id: a\ngenerated: { at: x }\n', 'yaml')).toEqual([]);
  });
});

describe('lintFrontmatter: family scoping and registration', () => {
  /** A family that complains whenever it runs. */
  const noisy: OkfFamily = {
    id: 'noisy',
    keys: ['sources'],
    rules: [(ctx) => [ctx.at([0, 1], 'info', 'ran')]],
  };

  test("a family's rules run only when one of its keys is present", () => {
    expect(lintFrontmatter('type: x\n', 'okf', [noisy])).toEqual([]);
    expect(marks('type: x\nsources: []\n', 'okf', [noisy])).toEqual([['info', 't', 'noisy']]);
  });

  test('a family with no keys always runs in okf mode, never in yaml mode', () => {
    const always: OkfFamily = { ...noisy, keys: [] };
    expect(lintFrontmatter('type: x\n', 'okf', [always])).toHaveLength(1);
    expect(lintFrontmatter('type: x\n', 'yaml', [always])).toEqual([]);
  });

  test('a Concept with no sources gets no provenance findings', () => {
    const findings = lintFrontmatter('title: no type here\n', 'okf');
    expect(findings.some((f) => f.source === 'okf-provenance')).toBe(false);
  });

  test('a family can declare required keys at any path and they become errors', () => {
    const contract: OkfFamily = {
      id: 'contract',
      keys: ['executor'],
      required: [{ path: ['executor'], key: 'resource', spec: '§10.2' }],
    };
    const [f] = lintFrontmatter('executor: { receipt: [a] }\n', 'okf', [contract]);
    expect(f).toMatchObject({ severity: 'error', source: 'contract' });
    expect(f.message).toBe('Missing required key `resource` in `executor` (OKF §10.2)');
  });

  test('findings come back sorted by position', () => {
    const yaml = 'generated: { at: 2026-01-01T00:00:00Z }\nsources:\n  - id: a\ntitle: 5\n';
    const froms = lintFrontmatter(yaml, 'okf').map((f) => f.from);
    expect(froms).toEqual([...froms].sort((a, b) => a - b));
    expect(froms.length).toBe(4); // type missing, generated.by, sources[].resource, title
  });
});
