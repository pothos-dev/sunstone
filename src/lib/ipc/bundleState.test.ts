import { test, expect, beforeEach } from 'bun:test';
import type { BundleState } from '$lib/types';
import { fakeBackend } from './fake';
import { httpBackend } from './http';

// Persisted-BundleState round-trip parity between the fake and http backends.
//
// Both backends persist BundleState as JSON in localStorage. Loading must
// spread the parsed JSON over the defaults so that any field ADDED to
// BundleState later (a "future" field from a newer build) survives a reload
// without each loader having to enumerate it. This pins that contract for
// both backends so they cannot diverge again.

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

// Simulate a field added to BundleState in a future version: it is present in
// the persisted JSON but unknown to the loader's hand-written knowledge.
const futureState = {
  lastOpenConcept: 'a.md',
  expandedFolders: ['sub'],
  recentFiles: ['a.md'],
  futureField: 'must survive a reload',
} as unknown as BundleState;

test('http backend preserves unknown BundleState fields across a reload', async () => {
  await httpBackend.saveBundleState(futureState);
  await expect(httpBackend.loadBundleState()).resolves.toEqual(futureState);
});

test('fake backend preserves unknown BundleState fields across a reload', async () => {
  await fakeBackend.saveBundleState(futureState);
  await expect(fakeBackend.loadBundleState()).resolves.toEqual(futureState);
});
