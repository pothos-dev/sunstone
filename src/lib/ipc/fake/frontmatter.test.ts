// Unit tests for the fake backend's test-only `stripTagsFromFrontmatter`.
//
// Run with `bun test src/lib`. The index-parse kernels (`parseFrontmatter` /
// `parseFrontmatterKeys` / `parseFrontmatterFields`) migrated to the shared wasm
// source in family 11 (ADR 0006 §11-A); their goldens live in `sunstone-shared`
// (cargo). Only the line-based tag stripper (§11-D) remains a fake stand-in.
import { describe, expect, test } from 'bun:test';
import { stripTagsFromFrontmatter } from './frontmatter';

describe('stripTagsFromFrontmatter', () => {
  test('removes an inline tags: [...] line', () => {
    const content = '---\ntype: note\ntags: [a, b]\ntitle: T\n---\n\nBody\n';
    expect(stripTagsFromFrontmatter(content)).toBe('---\ntype: note\ntitle: T\n---\n\nBody\n');
  });

  test('removes a block-list tags: entry and its items', () => {
    const content = '---\ntype: note\ntags:\n  - a\n  - b\ntitle: T\n---\n';
    expect(stripTagsFromFrontmatter(content)).toBe('---\ntype: note\ntitle: T\n---\n');
  });

  test('returns null when there is no tags entry', () => {
    expect(stripTagsFromFrontmatter('---\ntype: note\ntitle: T\n---\n')).toBeNull();
  });

  test('stops dropping block items at the next key', () => {
    const content = '---\ntags:\n  - a\nother: x\n  - kept\n---\n';
    // `- a` under tags is dropped; once a non-list line (`other:`) appears,
    // stripping stops, so the later `- kept` line survives.
    expect(stripTagsFromFrontmatter(content)).toBe('---\nother: x\n  - kept\n---\n');
  });
});
