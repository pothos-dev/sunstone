import { describe, expect, test } from 'bun:test';
import { frontmatterLintMode } from './mode';

describe('frontmatterLintMode', () => {
  test('okf only when the root declares okf_version', () => {
    expect(frontmatterLintMode('a.md', '0.2', '')).toBe('okf');
    expect(frontmatterLintMode('a.md', null, '')).toBe('yaml');
  });

  test('no open file is yaml', () => {
    expect(frontmatterLintMode(null, '0.2', '')).toBe('yaml');
  });

  test('a file outside the declared root is yaml', () => {
    expect(frontmatterLintMode('docs/a.md', '0.2', 'docs')).toBe('okf');
    expect(frontmatterLintMode('README.md', '0.2', 'docs')).toBe('yaml');
    expect(frontmatterLintMode('docsx/a.md', '0.2', 'docs')).toBe('yaml');
  });

  test('reserved index.md / log.md are not Concepts', () => {
    expect(frontmatterLintMode('docs/index.md', '0.2', 'docs')).toBe('yaml');
    expect(frontmatterLintMode('docs/sub/log.md', '0.2', 'docs')).toBe('yaml');
  });
});
