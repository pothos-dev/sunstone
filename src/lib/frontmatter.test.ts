import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_FENCES,
  formatYaml,
  isParseable,
  joinConcept,
  scaffoldConcept,
  titleFromFilename,
  titleFromYaml,
  yamlError,
} from './frontmatter';
// `splitFrontmatter` is a wasm FREE export (ADR 0006 §11-B); the round-trip
// tests below consume it from the shared source so join/split stay inverses.
import { splitFrontmatter } from '$lib/wasm/exports';

describe('joinConcept', () => {
  test('re-fences a block around the body', () => {
    expect(joinConcept('type: Concept\n', '# Body\n')).toBe('---\ntype: Concept\n---\n# Body\n');
  });

  test('adds the missing trailing newline after the block', () => {
    expect(joinConcept('type: Concept', '# Body\n')).toBe('---\ntype: Concept\n---\n# Body\n');
  });

  test('empty or whitespace-only frontmatter emits NO fences', () => {
    expect(joinConcept('', '# Body\n')).toBe('# Body\n');
    expect(joinConcept('  \n\n', '# Body\n')).toBe('# Body\n');
  });

  test('re-emits the verbatim fences it was given', () => {
    const fences = { open: '--- \n', close: '...\n' };
    expect(joinConcept('a: 1\n', 'body', fences)).toBe('--- \na: 1\n...\nbody');
  });

  test('round-trips a Concept byte-for-byte through split', () => {
    const content = `---\n# a comment\ntype: Concept\ntags: [a, b]\ngenerated: { by: agent, at: 2026-01-01T00:00:00Z }\n---\n\n# Body\n`;
    const s = splitFrontmatter(content);
    expect(joinConcept(s.yaml, s.body, { open: s.open, close: s.close })).toBe(content);
  });

  test('round-trips a Concept with no frontmatter', () => {
    const content = '# Just a body\n';
    const s = splitFrontmatter(content);
    expect(joinConcept(s.yaml, s.body, { open: s.open, close: s.close })).toBe(content);
  });

  test('defaults to the canonical fences', () => {
    expect(DEFAULT_FENCES).toEqual({ open: '---\n', close: '---\n' });
  });
});

describe('yamlError / isParseable (the save gate)', () => {
  test('well-formed YAML has no error', () => {
    expect(yamlError('type: Concept\ntags: [a, b]\n')).toBeNull();
    expect(isParseable('generated: { by: agent, at: 2026-01-01T00:00:00Z }\n')).toBe(true);
  });

  test('an empty block is well-formed', () => {
    expect(isParseable('')).toBe(true);
  });

  test('a broken block reports an error with in-block offsets', () => {
    const yaml = 'type: Concept\n  bad: [1, 2\n';
    const err = yamlError(yaml);
    expect(err).not.toBeNull();
    expect(err!.message.length).toBeGreaterThan(0);
    expect(err!.from).toBeGreaterThanOrEqual(0);
    expect(err!.to).toBeGreaterThan(err!.from);
    expect(err!.to).toBeLessThanOrEqual(yaml.length);
    expect(isParseable(yaml)).toBe(false);
  });

  test('a duplicate key is NOT a well-formedness failure (it is a lint rule, ADR 0009)', () => {
    expect(isParseable('type: A\ntype: B\n')).toBe(true);
  });
});

describe('titleFromYaml', () => {
  test('reads a scalar title', () => {
    expect(titleFromYaml('type: Concept\ntitle: My note\n')).toBe('My note');
    expect(titleFromYaml("title: 'Quoted'\n")).toBe('Quoted');
  });

  test('trims surrounding whitespace', () => {
    expect(titleFromYaml('title: "  padded  "\n')).toBe('padded');
  });

  test('falls back to null for a missing, empty, non-string or unparseable title', () => {
    expect(titleFromYaml('type: Concept\n')).toBeNull();
    expect(titleFromYaml('title: "   "\n')).toBeNull();
    expect(titleFromYaml('title: [a, b]\n')).toBeNull();
    expect(titleFromYaml('title: { a: 1 }\n')).toBeNull();
    expect(titleFromYaml('')).toBeNull();
    expect(titleFromYaml('type: Concept\n  bad: [1, 2\n')).toBeNull();
    expect(titleFromYaml('- a\n- b\n')).toBeNull();
  });
});

describe('formatYaml', () => {
  test('preserves comments while reflowing', () => {
    const out = formatYaml('# keep me\ntype:    Concept\n');
    expect(out).not.toBeNull();
    expect(out).toContain('# keep me');
    expect(out).toContain('type: Concept');
  });

  test('returns null when the block is already formatted or does not parse', () => {
    expect(formatYaml('type: Concept')).toBeNull();
    expect(formatYaml('type: Concept\n  bad: [1, 2')).toBeNull();
  });
});

describe('titleFromFilename / scaffoldConcept', () => {
  test('humanizes a filename into a title', () => {
    expect(titleFromFilename('my-note.md')).toBe('My note');
    expect(titleFromFilename('dir/foo_bar.md')).toBe('Foo bar');
    expect(titleFromFilename('.md')).toBe('');
  });

  test('scaffold emits an empty type and a derived title', () => {
    expect(scaffoldConcept('my-note.md')).toBe('---\ntype:\ntitle: My note\n---\n\n');
  });
});
