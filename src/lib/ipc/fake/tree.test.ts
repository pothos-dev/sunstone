import { afterEach, describe, expect, test } from 'bun:test';
import type { TreeNode } from '$lib/types';
import { FILES, FOLDERS } from './store';
import { buildTree, applyDelete, applyRename } from './tree';

// These ops mutate the shared in-memory fixture; restore it after each test
// so ordering never leaks (other fake specs read the same live `FILES`/`FOLDERS`).
const filesSnapshot = { ...FILES };
const foldersSnapshot = new Set(FOLDERS);

afterEach(() => {
  for (const key of Object.keys(FILES)) if (!(key in filesSnapshot)) delete FILES[key];
  for (const [key, value] of Object.entries(filesSnapshot)) FILES[key] = value;
  FOLDERS.clear();
  for (const folder of foldersSnapshot) FOLDERS.add(folder);
});

const childNames = (node: TreeNode) => (node.children ?? []).map((c) => c.name);
const findChild = (node: TreeNode, name: string) =>
  (node.children ?? []).find((c) => c.name === name);

describe('buildTree', () => {
  test('root node is the bundle with path "" and infers directories from file paths', () => {
    const root = buildTree();
    expect(root).toMatchObject({ name: 'bundle', path: '', isDir: true });

    const concepts = findChild(root, 'concepts');
    expect(concepts).toMatchObject({ path: 'concepts', isDir: true });

    const editor = findChild(concepts!, 'editor');
    expect(editor).toMatchObject({ path: 'concepts/editor', isDir: true });
    expect(editor!.children).toEqual([
      { name: 'live-preview.md', path: 'concepts/editor/live-preview.md', isDir: false },
    ]);
  });

  test('sorts each directory: dirs first, then files, alphabetically', () => {
    const root = buildTree();
    expect(childNames(root)).toEqual(['concepts', 'index.md', 'log.md']);

    const concepts = findChild(root, 'concepts')!;
    expect(childNames(concepts)).toEqual([
      'editor',
      'annotated.md',
      'bundle.md',
      'codemirror.md',
      'complex-frontmatter.md',
      'duplicate-keys.md',
      'index.md',
      'links-demo.md',
      'no-frontmatter.md',
      'outline-demo.md',
      'search-overflow.md',
    ]);
  });

  test('includes explicitly-created empty folders from FOLDERS (with ancestors)', () => {
    FOLDERS.add('drafts/nested');
    const root = buildTree();

    const drafts = findChild(root, 'drafts');
    expect(drafts).toMatchObject({ path: 'drafts', isDir: true });
    const nested = findChild(drafts!, 'nested');
    expect(nested).toMatchObject({ path: 'drafts/nested', isDir: true, children: [] });

    // Empty folder sorts among the dirs, before all root files.
    expect(childNames(root)).toEqual(['concepts', 'drafts', 'index.md', 'log.md']);
  });

  test('files are leaf nodes without a children array', () => {
    const root = buildTree();
    const index = findChild(root, 'index.md')!;
    expect(index.isDir).toBe(false);
    expect(index.children).toBeUndefined();
  });
});

describe('applyDelete', () => {
  test('deletes a single file and returns its path', () => {
    expect(applyDelete('log.md')).toEqual(['log.md']);
    expect(FILES['log.md']).toBeUndefined();
  });

  test('recursively deletes a folder: descendant files first, then the folder itself', () => {
    FOLDERS.add('concepts/editor'); // also tracked explicitly
    const removed = applyDelete('concepts/editor');
    // Descendant files precede the folder path in the returned list.
    expect(removed).toEqual(['concepts/editor/live-preview.md', 'concepts/editor']);
    expect(FILES['concepts/editor/live-preview.md']).toBeUndefined();
    expect(FOLDERS.has('concepts/editor')).toBe(false);
  });

  test('deleting a folder removes tracked subfolders too', () => {
    FOLDERS.add('drafts');
    FOLDERS.add('drafts/nested');
    const removed = applyDelete('drafts');
    // Empty folders contribute no file paths; only the folder itself is reported.
    expect(removed).toEqual(['drafts']);
    expect(FOLDERS.has('drafts')).toBe(false);
    expect(FOLDERS.has('drafts/nested')).toBe(false);
  });

  test('deleting a non-existent path is a no-op returning []', () => {
    expect(applyDelete('nope.md')).toEqual([]);
    expect(applyDelete('no-such-folder')).toEqual([]);
  });
});

describe('applyRename folder moves', () => {
  test('moves a folder and rewrites every descendant path, tracking the new folder', () => {
    applyRename('concepts/editor', 'concepts/editor2');
    expect(FILES['concepts/editor2/live-preview.md']).toBeDefined();
    expect(FILES['concepts/editor/live-preview.md']).toBeUndefined();
    expect(FOLDERS.has('concepts/editor2')).toBe(true);
  });

  test('rejects a folder move into a non-existent parent, leaving state untouched', () => {
    expect(() => applyRename('concepts/editor', 'ghost/editor')).toThrow(
      /target folder does not exist/,
    );
    expect(FILES['concepts/editor/live-preview.md']).toBeDefined();
  });
});
