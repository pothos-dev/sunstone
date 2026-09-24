import { describe, expect, test } from 'bun:test';
import type { TreeNode } from './types';
import {
  flattenVisible,
  indexOfPath,
  neighborAfterRemoval,
  nextIndexClamped,
  ordinaryChildren,
  prevIndexClamped,
  reservedChildren,
  folderIndexPath,
} from './treeNav';

// A small Bundle tree: a `concepts/` folder with a nested `editor/` folder,
// some Concepts, and a reserved `index.md` that must NOT appear as a row.
const tree: TreeNode = {
  name: '',
  path: '',
  isDir: true,
  children: [
    { name: 'index.md', path: 'index.md', isDir: false }, // reserved → skipped
    { name: 'readme.md', path: 'readme.md', isDir: false },
    {
      name: 'concepts',
      path: 'concepts',
      isDir: true,
      children: [
        { name: 'index.md', path: 'concepts/index.md', isDir: false }, // reserved
        { name: 'codemirror.md', path: 'concepts/codemirror.md', isDir: false },
        {
          name: 'editor',
          path: 'concepts/editor',
          isDir: true,
          children: [
            { name: 'live-preview.md', path: 'concepts/editor/live-preview.md', isDir: false },
          ],
        },
        { name: 'notes.txt', path: 'concepts/notes.txt', isDir: false }, // non-md → skipped
      ],
    },
  ],
};

describe('flattenVisible', () => {
  test('returns [] for a null root', () => {
    expect(flattenVisible(null, () => true)).toEqual([]);
  });

  test('skips children of collapsed folders', () => {
    const rows = flattenVisible(tree, () => false); // nothing expanded
    expect(rows.map((r) => r.path)).toEqual(['readme.md', 'concepts']);
    const concepts = rows[1];
    expect(concepts.isDir).toBe(true);
    expect(concepts.expanded).toBe(false);
    expect(concepts.depth).toBe(0);
  });

  test('descends into expanded folders, skipping reserved + non-md files', () => {
    const expanded = new Set(['concepts']);
    const rows = flattenVisible(tree, (p) => expanded.has(p));
    // concepts is expanded but concepts/editor is not.
    expect(rows.map((r) => r.path)).toEqual([
      'readme.md',
      'concepts',
      'concepts/codemirror.md',
      'concepts/editor',
    ]);
  });

  test('descends recursively when nested folders are expanded', () => {
    const expanded = new Set(['concepts', 'concepts/editor']);
    const rows = flattenVisible(tree, (p) => expanded.has(p));
    expect(rows.map((r) => r.path)).toEqual([
      'readme.md',
      'concepts',
      'concepts/codemirror.md',
      'concepts/editor',
      'concepts/editor/live-preview.md',
    ]);
    const leaf = rows[4];
    expect(leaf.depth).toBe(2);
    expect(leaf.parentPath).toBe('concepts/editor');
    expect(leaf.isDir).toBe(false);
  });

  test('records depth and parentPath per row', () => {
    const rows = flattenVisible(tree, () => true);
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
    expect(byPath['concepts'].depth).toBe(0);
    expect(byPath['concepts'].parentPath).toBe('');
    expect(byPath['concepts/codemirror.md'].depth).toBe(1);
    expect(byPath['concepts/codemirror.md'].parentPath).toBe('concepts');
  });
});

describe('indexOfPath', () => {
  const rows = flattenVisible(tree, () => true);
  test('finds an existing path', () => {
    expect(indexOfPath(rows, 'concepts')).toBe(1);
  });
  test('returns -1 for a missing or null path', () => {
    expect(indexOfPath(rows, 'nope.md')).toBe(-1);
    expect(indexOfPath(rows, null)).toBe(-1);
  });
});

describe('neighborAfterRemoval', () => {
  // All expanded: readme, concepts, concepts/codemirror, concepts/editor,
  // concepts/editor/live-preview.
  const rows = flattenVisible(tree, () => true);

  test('picks the NEXT visible row when one follows', () => {
    expect(neighborAfterRemoval(rows, 'readme.md')).toBe('concepts');
    expect(neighborAfterRemoval(rows, 'concepts/codemirror.md')).toBe('concepts/editor');
  });

  test('picks the PREVIOUS row when the removed one was last', () => {
    expect(neighborAfterRemoval(rows, 'concepts/editor/live-preview.md')).toBe(
      'concepts/editor',
    );
  });

  test('skips the removed folder’s descendants (no self-replacement)', () => {
    // Removing `concepts/editor` (which has a child row directly after) lands on
    // the row AFTER its subtree — here that is past the end, so the PREVIOUS row.
    expect(neighborAfterRemoval(rows, 'concepts/editor')).toBe('concepts/codemirror.md');
    // Removing `concepts` (whole subtree) lands on the previous top-level row.
    expect(neighborAfterRemoval(rows, 'concepts')).toBe('readme.md');
  });

  test('returns null for an absent path or a sole row', () => {
    expect(neighborAfterRemoval(rows, 'nope.md')).toBeNull();
    expect(neighborAfterRemoval([{ path: 'only.md', isDir: false, depth: 0, parentPath: '', expanded: false }], 'only.md')).toBeNull();
  });
});

describe('nextIndexClamped', () => {
  test('advances by one', () => {
    expect(nextIndexClamped(0, 4)).toBe(1);
    expect(nextIndexClamped(2, 4)).toBe(3);
  });
  test('clamps at the last row (no wrap)', () => {
    expect(nextIndexClamped(3, 4)).toBe(3);
  });
  test('lands on the first row from -1 (nothing focused)', () => {
    expect(nextIndexClamped(-1, 4)).toBe(0);
  });
  test('returns 0 for an empty list', () => {
    expect(nextIndexClamped(0, 0)).toBe(0);
    expect(nextIndexClamped(-1, 0)).toBe(0);
  });
});

describe('prevIndexClamped', () => {
  test('steps back by one', () => {
    expect(prevIndexClamped(2, 4)).toBe(1);
    expect(prevIndexClamped(1, 4)).toBe(0);
  });
  test('clamps at the first row (no wrap)', () => {
    expect(prevIndexClamped(0, 4)).toBe(0);
  });
  test('lands on the first row from -1 (nothing focused)', () => {
    expect(prevIndexClamped(-1, 4)).toBe(0);
  });
  test('returns 0 for an empty list', () => {
    expect(prevIndexClamped(0, 0)).toBe(0);
  });
});

describe('ordinaryChildren', () => {
  test('keeps folders and .md Concepts, drops reserved + non-markdown', () => {
    const root = tree.children![2]; // concepts/
    expect(ordinaryChildren(root).map((c) => c.path)).toEqual([
      'concepts/codemirror.md',
      'concepts/editor',
    ]);
  });
});

describe('reservedChildren', () => {
  test('returns reserved files in canonical order (index before log)', () => {
    const node: TreeNode = {
      name: '',
      path: '',
      isDir: true,
      children: [
        { name: 'log.md', path: 'log.md', isDir: false },
        { name: 'readme.md', path: 'readme.md', isDir: false },
        { name: 'index.md', path: 'index.md', isDir: false },
      ],
    };
    expect(reservedChildren(node)).toEqual([
      { path: 'index.md', kind: 'index' },
      { path: 'log.md', kind: 'log' },
    ]);
  });
  test('empty when there are no reserved files', () => {
    expect(reservedChildren(tree.children![2])).toEqual([
      { path: 'concepts/index.md', kind: 'index' },
    ]);
  });
});

describe('folderIndexPath', () => {
  test("a folder's own index.md", () => {
    expect(folderIndexPath(tree, 'concepts')).toBe('concepts/index.md');
    expect(folderIndexPath(tree, '')).toBe('index.md');
  });

  test('null when the folder has no index or is missing', () => {
    expect(folderIndexPath(tree, 'concepts/editor')).toBeNull();
    expect(folderIndexPath(tree, 'nope')).toBeNull();
    expect(folderIndexPath(null, 'concepts')).toBeNull();
  });
});
