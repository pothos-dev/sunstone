import { afterEach, describe, expect, test } from 'bun:test';
import { FILES, FOLDERS } from './store';
import { applyRename } from './tree';
import { fakeBackend } from '../fake';

// These CRUD ops mutate the shared in-memory fixture; restore it after each test
// so ordering never leaks (other fake specs read the same live `FILES`/`FOLDERS`).
const filesSnapshot = { ...FILES };
const foldersSnapshot = new Set(FOLDERS);

afterEach(() => {
  for (const key of Object.keys(FILES)) if (!(key in filesSnapshot)) delete FILES[key];
  for (const [key, value] of Object.entries(filesSnapshot)) FILES[key] = value;
  FOLDERS.clear();
  for (const folder of foldersSnapshot) FOLDERS.add(folder);
});

// The fake must be behaviourally faithful to the Rust backend (bundle.rs):
// creating a Concept or renaming into a folder that does not exist FAILS there
// (the OS `fs::write`/`fs::rename` errors; `rename_path` checks the target
// parent explicitly). Without these checks the fake was laxer than production,
// so Playwright could green-light a frontend that relies on the lax behaviour.

describe('applyRename target-folder faithfulness', () => {
  test('rejects a rename into a non-existent target folder', () => {
    expect(() => applyRename('index.md', 'ghost-dir/index.md')).toThrow(
      /target folder does not exist/,
    );
    // Rejected before any mutation: the source is untouched.
    expect(FILES['index.md']).toBeDefined();
    expect(FILES['ghost-dir/index.md']).toBeUndefined();
  });

  test('still rejects an existing target and a missing source', () => {
    expect(() => applyRename('index.md', 'log.md')).toThrow(/already exists/);
    expect(() => applyRename('does-not-exist.md', 'x.md')).toThrow(/no such path/);
  });

  test('allows a rename whose target folder exists', () => {
    applyRename('index.md', 'concepts/index-moved.md');
    expect(FILES['concepts/index-moved.md']).toBeDefined();
    expect(FILES['index.md']).toBeUndefined();
  });
});

describe('fakeBackend.createConcept parent faithfulness', () => {
  test('rejects a Concept whose parent folder does not exist', async () => {
    await expect(fakeBackend.createConcept('ghost-dir/new.md')).rejects.toThrow(
      /parent folder does not exist/,
    );
    expect(FILES['ghost-dir/new.md']).toBeUndefined();
  });

  test('creates a Concept when the parent folder exists', async () => {
    await fakeBackend.createConcept('concepts/unit-new.md');
    expect(FILES['concepts/unit-new.md']).toBe('');
  });

  test('creates a root-level Concept (empty parent is the Bundle root)', async () => {
    await fakeBackend.createConcept('root-new.md');
    expect(FILES['root-new.md']).toBe('');
  });
});
