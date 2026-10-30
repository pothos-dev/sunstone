import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FAKE_CONFIG_KEY, loadFakeConfig, readFakeConfig, saveFakeConfigEdits } from './config';

// The bun test runtime has no DOM `localStorage`; install a minimal in-memory
// stand-in so the storage-guarded paths run.
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

describe('fake config.json', () => {
  test('a missing entry loads as null and a save creates it', () => {
    expect(loadFakeConfig()).toBeNull();
    saveFakeConfigEdits([{ path: ['theme'], value: 'dark' }]);
    expect(loadFakeConfig()).toEqual({ theme: 'dark' });
  });

  test('a save changes only the edited paths', () => {
    store.set(FAKE_CONFIG_KEY, JSON.stringify({ note: 'mine', fonts: { code: { files: ['a.woff2'] } } }));
    saveFakeConfigEdits([{ path: ['fonts', 'code', 'size'], value: 0.9 }]);
    expect(readFakeConfig()).toEqual({ note: 'mine', fonts: { code: { files: ['a.woff2'], size: 0.9 } } });
  });

  test('a corrupt or non-object entry is never overwritten', () => {
    store.set(FAKE_CONFIG_KEY, '{ broken');
    expect(() => saveFakeConfigEdits([{ path: ['theme'], value: 'dark' }])).toThrow();
    expect(store.get(FAKE_CONFIG_KEY)).toBe('{ broken');
    expect(readFakeConfig()).toBeNull();
    store.set(FAKE_CONFIG_KEY, '[1]');
    expect(loadFakeConfig()).toBeNull();
    expect(() => saveFakeConfigEdits([{ path: ['theme'], value: 'dark' }])).toThrow();
  });

  test('a non-settings path refuses the whole batch', () => {
    expect(() =>
      saveFakeConfigEdits([
        { path: ['theme'], value: 'dark' },
        { path: ['note'], value: 'gone' },
      ]),
    ).toThrow();
    expect(store.has(FAKE_CONFIG_KEY)).toBe(false);
  });
});
