import { describe, expect, test } from 'bun:test';
import { completeFrontmatter } from './complete';
import type { OkfFamily } from './family';

/** Complete at the `|` marker; returns the offered labels (or null). */
function labelsAt(marked: string, families?: OkfFamily[]): string[] | null {
  const pos = marked.indexOf('|');
  const yaml = marked.slice(0, pos) + marked.slice(pos + 1);
  return completeFrontmatter(yaml, pos, 'okf', families)?.options.map((o) => o.label) ?? null;
}

describe('completeFrontmatter', () => {
  test('nothing at all outside OKF mode', () => {
    expect(completeFrontmatter('', 0, 'yaml')).toBeNull();
    expect(completeFrontmatter('ty', 2, 'yaml')).toBeNull();
  });

  test('top level offers the core keys and every family key', () => {
    const labels = labelsAt('|')!;
    expect(labels.slice(0, 5)).toEqual(['type', 'title', 'description', 'resource', 'tags']);
    for (const k of ['sources', 'usage_window', 'generated', 'verified', 'status', 'stale_after']) {
      expect(labels).toContain(k);
    }
    expect(labels).not.toContain('timestamp');
  });

  test('keys already present at that level are left out', () => {
    const labels = labelsAt('type: x\n|\ntitle: y\n')!;
    expect(labels).not.toContain('type');
    expect(labels).not.toContain('title');
    expect(labels).toContain('description');
  });

  test('the typed prefix sets `from`; options insert `key: `', () => {
    const r = completeFrontmatter('type: x\ndes', 11, 'okf')!;
    expect(r).toMatchObject({ from: 8, kind: 'key', prefix: 'des' });
    expect(r.options.find((o) => o.label === 'description')?.apply).toBe('description: ');
  });

  test('inside a family that is present: its nested keys', () => {
    expect(labelsAt('type: x\ngenerated:\n  |')).toEqual(['by', 'at']);
    expect(labelsAt('type: x\ngenerated:\n  by: a\n  |')).toEqual(['at']);
  });

  test('a new list item and a continued list item under sources', () => {
    const entry = ['resource', 'id', 'title', 'author', 'usage_count', 'last_modified', 'usage_window'];
    expect(labelsAt('sources:\n  - |')).toEqual(entry);
    expect(labelsAt('sources:\n  - id: a\n    |')).toEqual(entry.filter((k) => k !== 'id'));
    // A second item does not inherit the first item's keys.
    expect(labelsAt('sources:\n  - id: a\n  - |')).toEqual(entry);
    // Items at the same indent as their key (also valid YAML).
    expect(labelsAt('sources:\n- resource: x\n  |')).toEqual(entry.filter((k) => k !== 'resource'));
  });

  test('deeper nesting and back out to the top', () => {
    expect(labelsAt('sources:\n  - id: a\n    usage_window:\n      |')).toEqual(['from', 'to']);
    expect(labelsAt('sources:\n  - id: a\n|')).toContain('type');
    expect(labelsAt('sources:\n  - id: a\n|')).not.toContain('sources');
  });

  test('verified list entries get by/at', () => {
    expect(labelsAt('verified:\n  - |')).toEqual(['by', 'at']);
  });

  test('blank and comment lines do not break the walk', () => {
    expect(labelsAt('generated:\n  # who\n\n  |')).toEqual(['by', 'at']);
  });

  test('no options under an unknown key, or mid-line', () => {
    expect(labelsAt('owner:\n  |')).toBeNull();
    expect(labelsAt('ty|pe: x')).toBeNull();
  });

  test('values come from the family that owns the key', () => {
    const status: OkfFamily = {
      id: 'lifecycle-test',
      keys: ['status'],
      completions: [
        { path: ['status'], values: [{ label: 'draft' }, { label: 'stable' }, { label: 'deprecated' }] },
      ],
    };
    expect(labelsAt('type: x\nstatus: |', [status])).toEqual(['draft', 'stable', 'deprecated']);
    const r = completeFrontmatter('status: st', 10, 'okf', [status])!;
    expect(r).toMatchObject({ from: 8, kind: 'value', prefix: 'st' });
    expect(labelsAt('type: |', [status])).toBeNull();
  });
});
