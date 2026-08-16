import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { KnownBundle } from '$lib/types';
import {
  KNOWN_BUNDLES_KEY,
  bundleName,
  loadKnownBundles,
  saveKnownBundles,
  sortKnownBundles,
  touchKnownBundle,
} from './launcher';

// The bun test runtime has no DOM `localStorage`; install a minimal in-memory
// stand-in so the storage-guarded paths (`typeof localStorage`) run.
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

beforeEach(() => store.clear());
afterEach(() => store.clear());

const kb = (path: string, name: string, lastOpened: number | null): KnownBundle => ({
  path,
  name,
  lastOpened,
  exists: true,
});

describe('sortKnownBundles', () => {
  test('sorts newest-first by lastOpened', () => {
    const sorted = sortKnownBundles([kb('/a', 'a', 1), kb('/c', 'c', 3), kb('/b', 'b', 2)]);
    expect(sorted.map((b) => b.path)).toEqual(['/c', '/b', '/a']);
  });

  test('null lastOpened sorts last', () => {
    const sorted = sortKnownBundles([kb('/x', 'x', null), kb('/y', 'y', 1)]);
    expect(sorted.map((b) => b.path)).toEqual(['/y', '/x']);
  });

  test('ties break by name, case-insensitively', () => {
    const sorted = sortKnownBundles([kb('/b', 'Beta', 5), kb('/a', 'alpha', 5)]);
    expect(sorted.map((b) => b.name)).toEqual(['alpha', 'Beta']);
  });

  test('does not mutate the input', () => {
    const input = [kb('/a', 'a', 1), kb('/b', 'b', 2)];
    sortKnownBundles(input);
    expect(input.map((b) => b.path)).toEqual(['/a', '/b']);
  });
});

describe('bundleName', () => {
  test('takes the basename, ignoring trailing slashes', () => {
    expect(bundleName('/home/user/My Bundle')).toBe('My Bundle');
    expect(bundleName('/home/user/My Bundle/')).toBe('My Bundle');
  });

  test('falls back to the path itself when there is no segment', () => {
    expect(bundleName('')).toBe('');
    expect(bundleName('/')).toBe('/');
  });
});

describe('loadKnownBundles', () => {
  test('seeds three fixtures on first use and persists them', () => {
    const list = loadKnownBundles();
    expect(list.map((b) => b.name)).toEqual(['Knowledge Base', 'Project Notes', 'Archive']);
    expect(store.has(KNOWN_BUNDLES_KEY)).toBe(true);
    // A second load reads the persisted list back, same order.
    expect(loadKnownBundles().map((b) => b.name)).toEqual([
      'Knowledge Base',
      'Project Notes',
      'Archive',
    ]);
  });

  test('returns the stored list sorted newest-first', () => {
    saveKnownBundles([kb('/old', 'old', 1), kb('/new', 'new', 2)]);
    expect(loadKnownBundles().map((b) => b.path)).toEqual(['/new', '/old']);
  });

  test('corrupt JSON yields an empty list', () => {
    localStorage.setItem(KNOWN_BUNDLES_KEY, 'not json{');
    expect(loadKnownBundles()).toEqual([]);
  });

  test('a non-array JSON value yields an empty list', () => {
    localStorage.setItem(KNOWN_BUNDLES_KEY, '{"nope":true}');
    expect(loadKnownBundles()).toEqual([]);
  });
});

describe('touchKnownBundle', () => {
  test('adds a new path with a stamp newer than every existing entry', () => {
    saveKnownBundles([kb('/a', 'a', 100), kb('/b', 'b', 200)]);
    touchKnownBundle('/home/user/Fresh');
    const list = loadKnownBundles();
    expect(list[0]).toEqual({
      path: '/home/user/Fresh',
      name: 'Fresh',
      lastOpened: 1200, // max existing stamp (200) + 1000
      exists: true,
    });
    expect(list.map((b) => b.path)).toEqual(['/home/user/Fresh', '/b', '/a']);
  });

  test('re-touching an existing path moves it to the front without duplicating it', () => {
    saveKnownBundles([kb('/a', 'a', 100), kb('/b', 'b', 200)]);
    touchKnownBundle('/a');
    const list = loadKnownBundles();
    expect(list.map((b) => b.path)).toEqual(['/a', '/b']);
    expect(list[0].lastOpened).toBe(1200); // max of the OTHERS (200) + 1000
    expect(list.length).toBe(2);
  });

  test('null lastOpened entries count as 0 for the new stamp', () => {
    saveKnownBundles([kb('/x', 'x', null)]);
    touchKnownBundle('/y');
    expect(loadKnownBundles()[0]).toEqual({ path: '/y', name: 'y', lastOpened: 1000, exists: true });
  });
});
