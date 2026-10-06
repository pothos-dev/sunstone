import { describe, expect, test } from 'bun:test';
import { defaultYamlFolds, yamlFoldAt } from './yamlFold';

const at = (text: string, line: number) => yamlFoldAt(text.split('\n'), line);

describe('yamlFoldAt', () => {
  test('a key over an indented list folds the list, counting entries', () => {
    const text = 'type: Note\nsources:\n  - id: a\n    resource: x\n  - id: b\n    resource: y\ntitle: T';
    expect(at(text, 1)).toEqual({ header: 1, last: 5, summary: '2 entries' });
  });

  test('a key over a same-indent list folds it too', () => {
    const text = 'sources:\n- id: a\n  resource: x\n- id: b\ntitle: T';
    expect(at(text, 0)).toEqual({ header: 0, last: 3, summary: '2 entries' });
  });

  test('a list entry folds its keys, counting its own first key', () => {
    const text = 'sources:\n  - id: a\n    resource: x\n    title: X\n  - id: b';
    expect(at(text, 1)).toEqual({ header: 1, last: 3, summary: '3 keys' });
  });

  test('a nested map counts keys', () => {
    expect(at('generated:\n  by: human:d\n  at: 2026-10-06\nx: 1', 0)?.summary).toBe('2 keys');
  });

  test('a block scalar counts lines', () => {
    expect(at('description: |\n  one\n  two\n  three\ntype: N', 0)).toEqual({
      header: 0,
      last: 3,
      summary: '3 lines',
    });
  });

  test('blank and comment lines inside a block fold with it, trailing ones do not', () => {
    const text = 'sources:\n  - id: a\n\n  # note\n  - id: b\n\ntitle: T';
    expect(at(text, 0)).toEqual({ header: 0, last: 4, summary: '2 entries' });
  });

  test('scalars, lone keys and comments do not fold', () => {
    const text = 'type: Note\nempty:\n# comment\n  indented: under a comment';
    expect(at(text, 0)).toBeNull();
    expect(at(text, 2)).toBeNull();
    // `empty:` is followed by a deeper line (after the comment), so it does fold.
    expect(at(text, 1)?.summary).toBe('1 key');
    expect(at('a: 1\nb: 2', 0)).toBeNull();
  });

  test('singular summaries', () => {
    expect(at('sources:\n  - id: a', 0)?.summary).toBe('1 entry');
  });
});

describe('defaultYamlFolds', () => {
  test('folds only top-level sources and verified', () => {
    const text = [
      'type: Note',
      'generated:',
      '  by: human:d',
      'sources:',
      '  - id: a',
      'verified:',
      '  - { by: human:d, at: 2026-10-06T00:00:00Z }',
      'nested:',
      '  sources:',
      '    - id: z',
    ].join('\n');
    expect(defaultYamlFolds(text).map((f) => [f.header, f.last])).toEqual([
      [3, 4],
      [5, 6],
    ]);
  });

  test('a default key with no block does not fold', () => {
    expect(defaultYamlFolds('sources: []\nverified:')).toEqual([]);
  });
});
