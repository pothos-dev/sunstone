// Unit tests for the TS-only `conceptTitle` (ADR 0006 family 13). The
// path↔URL mapping (`conceptToUrl` / `urlToConcept`) and `collectFilePaths`
// migrated to Rust (`sunstone_shared::url` + the `BundleIndex.urlToConcept`
// handle) — their goldens live in `cargo test`. `conceptTitle` reads the
// `RenderPayload` (no Rust twin), so it stays TS and keeps its test.
import { describe, expect, test } from 'bun:test';
import type { RenderPayload } from './render';
import { conceptTitle } from './conceptUrl';

describe('conceptTitle', () => {
  const render = (over: Partial<RenderPayload>): RenderPayload => ({
    html: '',
    frontmatter: [],
    outline: [],
    ...over,
  });

  test('prefers frontmatter title', () => {
    const r = render({
      frontmatter: [{ key: 'title', values: ['Mistral AI'] }],
      outline: [{ level: 1, text: 'H1 Ignored', line: 1, slug: 'h1' }],
    });
    expect(conceptTitle('research/providers/mistral-ai.md', r)).toBe('Mistral AI');
  });

  test('falls back to the first H1', () => {
    const r = render({ outline: [{ level: 1, text: 'Good Concept', line: 1, slug: 'good' }] });
    expect(conceptTitle('good.md', r)).toBe('Good Concept');
  });

  test('falls back to the path name (folder index → folder name)', () => {
    expect(conceptTitle('good.md', render({}))).toBe('good');
    expect(conceptTitle('providers/index.md', render({}))).toBe('providers');
  });

  test('uses Sunstone Web when nothing is open or the path is the root index', () => {
    expect(conceptTitle(null, null)).toBe('Sunstone Web');
    expect(conceptTitle('index.md', render({}))).toBe('Sunstone Web');
  });
});
