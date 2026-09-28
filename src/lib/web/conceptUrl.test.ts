// Unit tests for the TS-only `conceptTitle` (ADR 0006 family 13). The
// path↔URL mapping (`conceptToUrl` / `urlToConcept`) and `collectFilePaths`
// migrated to Rust (`sunstone_shared::url` + the `BundleIndex.urlToConcept`
// handle) — their goldens live in `cargo test`. `conceptTitle` reads the
// `RenderPayload` (no Rust twin), so it stays TS and keeps its test.
// `urlToConceptInline` is the SSR-only TS copy of `urlToConcept`; its tests
// below pin both its goldens and parity with the shipped wasm handle.
import { describe, expect, test } from 'bun:test';
import * as wasm from '$lib/wasm/pkg';
import type { RenderPayload } from './render';
import { conceptTitle, urlToConceptInline } from './conceptUrl';

describe('urlToConceptInline', () => {
  const paths = [
    'index.md',
    'good.md',
    'a.md',
    'a/index.md',
    'a/b.md',
    'leaf.md',
    'folder/index.md',
    'deep/x/y.md',
    'notes.txt',
  ];

  /** The shipped wasm resolver over the same set. */
  const viaWasm = (urlPath: string, set: string[]): string | null => {
    const index = new wasm.BundleIndex(set);
    try {
      return index.urlToConcept(urlPath) ?? null;
    } finally {
      index.free();
    }
  };

  const cases: [string, string | null][] = [
    ['', 'index.md'],
    ['/', 'index.md'],
    ['//', 'index.md'],
    ['good', 'good.md'],
    ['/good/', 'good.md'],
    ['a', 'a/index.md'], // folder index beats the same-named leaf
    ['a/b', 'a/b.md'],
    ['a//b', 'a/b.md'], // repeated slashes collapse
    ['//a///b//', 'a/b.md'],
    ['folder', 'folder/index.md'],
    ['folder/index', 'folder/index.md'],
    ['leaf', 'leaf.md'],
    ['deep/x/y', 'deep/x/y.md'],
    ['deep/x', null], // a folder without an index
    ['unknown', null],
    ['good.md', null], // the pretty URL never carries `.md`
    ['notes', null], // only `.md` files are Concepts
  ];

  test.each(cases)('%p → %p', (url, expected) => {
    expect(urlToConceptInline(url, paths)).toBe(expected);
  });

  test.each(cases)('%p matches the wasm BundleIndex.urlToConcept', (url) => {
    expect(urlToConceptInline(url, paths)).toBe(viaWasm(url, paths));
  });

  test('the root is unresolved without a root index.md (and matches wasm)', () => {
    const set = ['good.md', 'a/index.md'];
    expect(urlToConceptInline('', set)).toBeNull();
    expect(urlToConceptInline('/', set)).toBe(viaWasm('/', set));
  });

  test('a leaf is found when no folder index exists (and matches wasm)', () => {
    const set = ['a.md', 'a/other.md'];
    expect(urlToConceptInline('a', set)).toBe('a.md');
    expect(viaWasm('a', set)).toBe('a.md');
  });
});

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
