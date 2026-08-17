// Unit tests for TreeCrud's pure tree/menu helpers. Run with `bun test src/lib`.
import { describe, expect, test } from 'bun:test';
import type { TreeNode } from './types';
import {
  childDirOf,
  folderHasReserved,
  folderPaths,
  menuItemsFor,
  nodeAt,
  renameSeed,
} from './treeCrud';

const file = (path: string): TreeNode => ({
  name: path.split('/').pop() ?? path,
  path,
  isDir: false,
});
const dir = (path: string, children: TreeNode[] = []): TreeNode => ({
  name: path.split('/').pop() ?? path,
  path,
  isDir: true,
  children,
});

// Bundle root ('') with a nested folder structure and some files.
const root = dir('', [
  file('a.md'),
  dir('docs', [file('docs/index.md'), file('docs/guide.md'), dir('docs/deep', [])]),
  dir('empty', []),
]);
root.name = '';

describe('childDirOf', () => {
  test('a folder is its own child dir', () => {
    expect(childDirOf(dir('docs'))).toBe('docs');
  });
  test('a file resolves to its containing folder', () => {
    expect(childDirOf(file('docs/guide.md'))).toBe('docs');
  });
  test('a root-level file resolves to the Bundle root', () => {
    expect(childDirOf(file('a.md'))).toBe('');
  });
});

describe('folderPaths', () => {
  test('collects every folder depth-first, root first', () => {
    expect(folderPaths(root)).toEqual(['', 'docs', 'docs/deep', 'empty']);
  });
  test('a file node yields nothing', () => {
    expect(folderPaths(file('a.md'))).toEqual([]);
  });
});

describe('nodeAt', () => {
  test('finds the root by empty path', () => {
    expect(nodeAt(root, '')).toBe(root);
  });
  test('finds a nested file and folder', () => {
    expect(nodeAt(root, 'docs/guide.md')?.name).toBe('guide.md');
    expect(nodeAt(root, 'docs/deep')?.isDir).toBe(true);
  });
  test('returns null for a missing path or null root', () => {
    expect(nodeAt(root, 'nope.md')).toBeNull();
    expect(nodeAt(null, '')).toBeNull();
  });
});

describe('renameSeed', () => {
  test('strips .md from a concept name', () => {
    expect(renameSeed(file('docs/guide.md'))).toBe('guide');
  });
  test('keeps a folder name intact', () => {
    expect(renameSeed(dir('docs'))).toBe('docs');
  });
});

describe('folderHasReserved', () => {
  const docs = nodeAt(root, 'docs')!;
  test('detects an existing index.md', () => {
    expect(folderHasReserved(docs, 'index')).toBe(true);
  });
  test('reports a missing log.md', () => {
    expect(folderHasReserved(docs, 'log')).toBe(false);
  });
});

describe('menuItemsFor', () => {
  test('a file gets the base items only', () => {
    expect(menuItemsFor(file('a.md')).map((i) => i.id)).toEqual([
      'newConcept',
      'newFolder',
      'rename',
      'move',
      'delete',
    ]);
  });

  test('a folder missing both reserved files offers both, first separated', () => {
    const items = menuItemsFor(dir('empty', []));
    expect(items.map((i) => i.id)).toEqual([
      'newConcept',
      'newFolder',
      'createReserved:index',
      'createReserved:log',
      'rename',
      'move',
      'delete',
    ]);
    expect(items[2].separated).toBe(true);
    expect(items[3].separated).toBe(false);
  });

  test('a folder with index.md offers only the missing log.md, separated', () => {
    const docs = nodeAt(root, 'docs')!;
    const items = menuItemsFor(docs);
    expect(items.map((i) => i.id)).toEqual([
      'newConcept',
      'newFolder',
      'createReserved:log',
      'rename',
      'move',
      'delete',
    ]);
    expect(items[2].separated).toBe(true);
    expect(items[2].label).toBe('Create log.md');
  });

  test('delete is separated and danger', () => {
    const del = menuItemsFor(file('a.md')).find((i) => i.id === 'delete')!;
    expect(del.separated).toBe(true);
    expect(del.danger).toBe(true);
  });
});
