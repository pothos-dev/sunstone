import { describe, expect, test } from 'bun:test';
import * as wasm from '$lib/wasm/pkg';
import { startupFromUrl } from './servedStartup';

const PATHS = ['index.md', 'guide/setup.md', 'providers.md', 'providers/index.md', 'api/notes.md', 'a b.md'];

// The shipped wasm handle, as `http.ts` uses it.
function resolve(pathname: string, hash = '') {
  const index = new wasm.BundleIndex(PATHS);
  try {
    return startupFromUrl(pathname, hash, PATHS, (p) => index.urlToConcept(p) ?? null);
  } finally {
    index.free();
  }
}

const open = (path: string, anchor: string | null = null) => ({ kind: 'open' as const, doc: { path, anchor } });

describe('startupFromUrl', () => {
  test('the root names no Concept, so the restored layout stands', () => {
    expect(resolve('/')).toBeNull();
    expect(resolve('')).toBeNull();
    expect(resolve('/index.html')).toBeNull();
  });

  test('a pretty URL resolves like Sunstone Web', () => {
    expect(resolve('/guide/setup')).toEqual(open('guide/setup.md'));
    expect(resolve('/guide/setup/')).toEqual(open('guide/setup.md'));
    expect(resolve('/providers')).toEqual(open('providers/index.md'));
    expect(resolve('/api/notes')).toEqual(open('api/notes.md'));
  });

  test('a Bundle path is taken literally', () => {
    expect(resolve('/guide/setup.md')).toEqual(open('guide/setup.md'));
    expect(resolve('/providers.md')).toEqual(open('providers.md'));
    expect(resolve('/index.md')).toEqual(open('index.md'));
  });

  test('the hash is the anchor, decoded', () => {
    expect(resolve('/guide/setup', '#install')).toEqual(open('guide/setup.md', 'install'));
    expect(resolve('/guide/setup.md', '#caf%C3%A9')).toEqual(open('guide/setup.md', 'café'));
    expect(resolve('/guide/setup', '#')).toEqual(open('guide/setup.md'));
  });

  test('percent-encoded segments are decoded', () => {
    expect(resolve('/a%20b')).toEqual(open('a b.md'));
    expect(resolve('/a%20b.md')).toEqual(open('a b.md'));
  });

  test('a path with no Concept behind it is reported', () => {
    expect(resolve('/guide/nope')).toEqual({ kind: 'missing', urlPath: '/guide/nope' });
    expect(resolve('/guide/nope.md')).toEqual({ kind: 'missing', urlPath: '/guide/nope.md' });
    expect(resolve('/bad%zz')).toEqual({ kind: 'missing', urlPath: '/bad%zz' });
  });
});
