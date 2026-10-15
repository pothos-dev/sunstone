import { describe, expect, test } from 'bun:test';
import * as wasm from '$lib/wasm/pkg';
import { servedAddress, startupFromUrl } from './servedStartup';

const PATHS = ['index.md', 'guide/setup.md', 'providers.md', 'providers/index.md', 'api/notes.md', 'a b.md'];

// The shipped wasm handle, as `http.ts` uses it.
function resolve(pathname: string, hash = '') {
  const index = new wasm.BundleIndex(PATHS, [], null);
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

describe('servedAddress', () => {
  const SERVED = [
    'index.md',
    'good.md',
    'guide.md',
    'guide/index.md',
    'guide/topic.md',
    'release-1.2.md',
    'v1.0/index.md',
    'v1.0/setup.md',
    'a b.md',
  ];

  function address(concept: string | null, pathname = '/', hash = '') {
    const index = new wasm.BundleIndex(SERVED, [], null);
    try {
      return servedAddress(
        concept,
        { pathname, hash },
        SERVED,
        (p) => index.urlToConcept(p) ?? null,
        wasm.conceptToUrl,
      );
    } finally {
      index.free();
    }
  }

  // The binding: the written URL reloads the same Concept.
  function reloads(href: string): string | null {
    const index = new wasm.BundleIndex(SERVED, [], null);
    try {
      const [pathname, hash = ''] = href.split('#');
      const link = startupFromUrl(pathname, hash ? `#${hash}` : '', SERVED, (p) => index.urlToConcept(p) ?? null);
      return link?.kind === 'open' ? link.doc.path : null;
    } finally {
      index.free();
    }
  }

  test('the pretty URL when it round-trips', () => {
    expect(address('good.md')).toBe('/good');
    expect(address('guide/topic.md')).toBe('/guide/topic');
    expect(address('guide/index.md')).toBe('/guide');
    expect(address('v1.0/setup.md')).toBe('/v1.0/setup');
    expect(address('a b.md')).toBe('/a%20b');
    expect(address('index.md')).toBe('/');
    expect(address(null)).toBe('/');
  });

  test('a dot in the last segment writes the Bundle path (the server 404s it otherwise)', () => {
    expect(address('release-1.2.md')).toBe('/release-1.2.md');
    expect(address('v1.0/index.md')).toBe('/v1.0/index.md');
  });

  test('a leaf shadowed by a same-named folder index writes the Bundle path', () => {
    expect(address('guide.md')).toBe('/guide.md');
  });

  test('every written URL reloads the same Concept', () => {
    for (const concept of SERVED.filter((p) => p !== 'index.md')) {
      expect(reloads(address(concept)!)).toBe(concept);
    }
  });

  test('the hash is kept while the URL already names the Concept', () => {
    expect(address('guide/topic.md', '/guide/topic.md', '#topic')).toBe('/guide/topic#topic');
    expect(address('guide/topic.md', '/guide/topic', '#topic')).toBe('/guide/topic#topic');
    expect(address('guide.md', '/guide.md', '#x')).toBe('/guide.md#x');
  });

  test('navigating to another Concept drops the hash', () => {
    expect(address('good.md', '/guide/topic', '#topic')).toBe('/good');
    // `/guide` names the folder index, not the shadowed leaf.
    expect(address('guide.md', '/guide', '#intro')).toBe('/guide.md');
  });

  test('a Concept the index does not know yet leaves the URL alone', () => {
    const none = servedAddress('good.md', { pathname: '/good.md', hash: '#a' }, [], () => null, wasm.conceptToUrl);
    expect(none).toBeNull();
  });
});
