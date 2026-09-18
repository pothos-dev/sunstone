// Unit tests for Embed resolution over the Attachment corpus (ei-1).
//
// These pin the COMPOSITION `indexStore.resolveEmbed` performs — which model
// runs, what the name model is given, and when `exists` is false — by injecting
// stub kernels. The kernels themselves are single-sourced in Rust
// (`crates/sunstone-shared/src/embed.rs`) and tested there; re-testing the
// ADR-0004 name rules here would be a TS twin of exactly what wasm ships.
import { describe, expect, test } from 'bun:test';
import {
  attachmentCorpus,
  resolveEmbedIn,
  EMPTY_CORPUS,
  type EmbedKernels,
} from './embedResolve';

const PATHS = ['assets/dot.png', 'concepts/assets/wide.png'];

/** Kernels that record their calls and answer from a fixed map. */
function stubKernels(
  answers: { path?: string | null; name?: string | null } = {},
): EmbedKernels & { calls: string[]; nameCorpus: string[] | null } {
  const rec = {
    calls: [] as string[],
    nameCorpus: null as string[] | null,
    resolvePath(_sourcePath: string, _target: string) {
      rec.calls.push('path');
      return answers.path ?? null;
    },
    resolveName(attachmentPaths: string[], _target: string) {
      rec.calls.push('name');
      rec.nameCorpus = attachmentPaths;
      return answers.name ?? null;
    },
  };
  return rec;
}

describe('attachmentCorpus', () => {
  test('holds the list and answers membership', () => {
    const corpus = attachmentCorpus(PATHS);
    expect(corpus.paths).toEqual(PATHS);
    expect(corpus.has('assets/dot.png')).toBe(true);
    expect(corpus.has('assets/missing.png')).toBe(false);
  });

  test('the empty corpus holds nothing', () => {
    expect(EMPTY_CORPUS.paths).toEqual([]);
    expect(EMPTY_CORPUS.has('assets/dot.png')).toBe(false);
  });
});

describe('resolveEmbedIn — path model', () => {
  const corpus = attachmentCorpus(PATHS);

  test('a resolved path that IS an Attachment exists', () => {
    const k = stubKernels({ path: 'assets/dot.png' });
    expect(resolveEmbedIn(corpus, 'index.md', './assets/dot.png', 'path', k)).toEqual({
      path: 'assets/dot.png',
      exists: true,
    });
    expect(k.calls).toEqual(['path']);
  });

  test('a resolved path with no Attachment behind it is the broken case', () => {
    // `exists: false` (not `null`) — the widget needs the path to render its
    // error placeholder and to stay debuggable.
    const k = stubKernels({ path: 'assets/gone.png' });
    expect(resolveEmbedIn(corpus, 'index.md', './assets/gone.png', 'path', k)).toEqual({
      path: 'assets/gone.png',
      exists: false,
    });
  });

  test('a non-Bundle target resolves to null', () => {
    // `https:`, `data:`, a pure anchor, empty — the kernel returns null and
    // there is nothing to look up in the corpus.
    const k = stubKernels({ path: null });
    expect(resolveEmbedIn(corpus, 'index.md', 'https://example.com/x.png', 'path', k)).toBeNull();
  });

  test('never consults the name kernel', () => {
    const k = stubKernels({ path: 'assets/dot.png', name: 'assets/dot.png' });
    resolveEmbedIn(corpus, 'index.md', './assets/dot.png', 'path', k);
    expect(k.calls).not.toContain('name');
  });
});

describe('resolveEmbedIn — name model', () => {
  const corpus = attachmentCorpus(PATHS);

  test('searches the ATTACHMENT corpus, not the concept set', () => {
    const k = stubKernels({ name: 'concepts/assets/wide.png' });
    const out = resolveEmbedIn(corpus, 'index.md', 'wide.png', 'name', k);
    expect(out).toEqual({ path: 'concepts/assets/wide.png', exists: true });
    // The corpus is handed to the kernel verbatim — that IS the candidate set.
    expect(k.nameCorpus).toEqual(PATHS);
    expect(k.calls).toEqual(['name']);
  });

  test('anything it resolves is an Attachment, so exists is always true', () => {
    const k = stubKernels({ name: 'assets/dot.png' });
    expect(resolveEmbedIn(corpus, 'deep/nested/x.md', 'dot.png', 'name', k)?.exists).toBe(true);
  });

  test('no matching Attachment resolves to null', () => {
    const k = stubKernels({ name: null });
    expect(resolveEmbedIn(corpus, 'index.md', 'nope.png', 'name', k)).toBeNull();
  });

  test('an empty corpus resolves nothing', () => {
    // Before the first refresh / on a degraded load: every Embed is broken
    // rather than throwing.
    const k = stubKernels({ name: null });
    expect(resolveEmbedIn(EMPTY_CORPUS, 'index.md', 'dot.png', 'name', k)).toBeNull();
    expect(k.nameCorpus).toEqual([]);
  });
});
