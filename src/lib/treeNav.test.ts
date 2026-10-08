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
  indexChild,
  linearMove,
  explorerKeyIntent,
  setNodeTitle,
  setNodeLifecycle,
  explorerTitle,
  folderNameClick,
  holdsPath,
  treeLabel,
  type VisibleRow,
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

describe('holdsPath', () => {
  test('every ancestor folder of a Concept holds it', () => {
    const p = 'concepts/editor/live-preview.md';
    expect(holdsPath('concepts', p)).toBe(true);
    expect(holdsPath('concepts/editor', p)).toBe(true);
  });

  test('unrelated folders, prefix look-alikes, the root and no Concept do not', () => {
    expect(holdsPath('other', 'concepts/a.md')).toBe(false);
    expect(holdsPath('concept', 'concepts/a.md')).toBe(false);
    expect(holdsPath('', 'concepts/a.md')).toBe(false);
    expect(holdsPath('concepts', null)).toBe(false);
  });

  test("a reserved file shows on its folder's row, so only the ancestors hold it", () => {
    expect(holdsPath('concepts/editor', 'concepts/editor/index.md')).toBe(false);
    expect(holdsPath('concepts', 'concepts/editor/index.md')).toBe(true);
  });
});

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

  test('pinned folders show expanded and are marked; own-expanded ones are not pinned', () => {
    const open = 'concepts/editor/live-preview.md';
    const rows = flattenVisible(tree, (p) => p === 'concepts', (p) => holdsPath(p, open));
    expect(rows.map((r) => r.path)).toEqual([
      'readme.md',
      'concepts',
      'concepts/codemirror.md',
      'concepts/editor',
      'concepts/editor/live-preview.md',
    ]);
    expect(rows[1]).toMatchObject({ expanded: true });
    expect(rows[1].pinned).toBeUndefined();
    expect(rows[3]).toMatchObject({ expanded: true, pinned: true });
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

describe('indexChild', () => {
  test("the node's own index.md, ignoring deeper ones", () => {
    expect(indexChild(tree)).toBe('index.md');
    expect(indexChild(tree.children![2])).toBe('concepts/index.md');
  });

  test('null for a folder without one, or a file node', () => {
    expect(indexChild(tree.children![2].children![2])).toBeNull();
    expect(indexChild(tree.children![1])).toBeNull();
  });

  test('matches the reserved name case-insensitively, but never a folder', () => {
    const node: TreeNode = {
      name: 'x',
      path: 'x',
      isDir: true,
      children: [
        { name: 'index.md', path: 'x/index.md', isDir: true, children: [] },
        { name: 'INDEX.md', path: 'x/INDEX.md', isDir: false },
      ],
    };
    expect(indexChild(node)).toBe('x/INDEX.md');
  });
});

describe('ordinaryChildren markdown filter', () => {
  test('keeps .md case-insensitively and drops other extensions', () => {
    const node: TreeNode = {
      name: '',
      path: '',
      isDir: true,
      children: [
        { name: 'A.MD', path: 'A.MD', isDir: false },
        { name: 'b.md.txt', path: 'b.md.txt', isDir: false },
        { name: 'c.markdown', path: 'c.markdown', isDir: false },
      ],
    };
    expect(ordinaryChildren(node).map((c) => c.path)).toEqual(['A.MD']);
  });
});

describe('linearMove', () => {
  test('ArrowDown/j and ArrowUp/k step one row, clamped at the ends', () => {
    expect(linearMove('ArrowDown', 0, 3)).toBe(1);
    expect(linearMove('j', 2, 3)).toBe(2);
    expect(linearMove('ArrowUp', 2, 3)).toBe(1);
    expect(linearMove('k', 0, 3)).toBe(0);
  });

  test('nothing focused (-1) lands on the first row either way', () => {
    expect(linearMove('j', -1, 3)).toBe(0);
    expect(linearMove('k', -1, 3)).toBe(0);
  });

  test('Home / End jump to the first / last row', () => {
    expect(linearMove('Home', 1, 3)).toBe(0);
    expect(linearMove('End', -1, 3)).toBe(2);
  });

  test('other keys and an empty list are not movement', () => {
    expect(linearMove('Enter', 0, 3)).toBeNull();
    expect(linearMove('l', 0, 3)).toBeNull();
    expect(linearMove('j', -1, 0)).toBeNull();
  });
});

describe('explorerKeyIntent', () => {
  const row = (path: string, parentPath: string, isDir = false, expanded = false): VisibleRow => ({
    path,
    isDir,
    depth: parentPath === '' ? 0 : parentPath.split('/').length,
    parentPath,
    expanded,
  });
  // open/ (expanded, one child), shut/ (collapsed), top.md
  const rows = [
    row('open', '', true, true),
    row('open/a.md', 'open'),
    row('shut', '', true, false),
    row('top.md', ''),
  ];

  test('linear movement focuses the target row', () => {
    expect(explorerKeyIntent('j', rows, 0)).toEqual({ focus: 'open/a.md' });
    expect(explorerKeyIntent('End', rows, 0)).toEqual({ focus: 'top.md' });
  });

  test('Right: collapsed folder expands, expanded folder enters, file is a no-op', () => {
    expect(explorerKeyIntent('ArrowRight', rows, 2)).toEqual({ expand: true });
    expect(explorerKeyIntent('l', rows, 0)).toEqual({ focus: 'open/a.md' });
    expect(explorerKeyIntent('l', rows, 3)).toEqual({});
  });

  test('Right on an expanded but empty folder is a no-op', () => {
    const empty = [row('e', '', true, true), row('z.md', '')];
    expect(explorerKeyIntent('l', empty, 0)).toEqual({});
  });

  test('Left: expanded folder collapses, a child goes to its parent, root rows stay', () => {
    expect(explorerKeyIntent('ArrowLeft', rows, 0)).toEqual({ expand: false });
    expect(explorerKeyIntent('h', rows, 1)).toEqual({ focus: 'open' });
    expect(explorerKeyIntent('h', rows, 2)).toEqual({});
    expect(explorerKeyIntent('h', rows, 3)).toEqual({});
  });

  test('Right/Left with nothing focused land on the first row', () => {
    expect(explorerKeyIntent('l', rows, -1)).toEqual({ focus: 'open' });
    expect(explorerKeyIntent('h', rows, -1)).toEqual({ focus: 'open' });
  });

  test('Enter / Space toggle a folder and open a file; unhandled with nothing focused', () => {
    expect(explorerKeyIntent('Enter', rows, 0)).toEqual({ expand: false });
    expect(explorerKeyIntent(' ', rows, 2)).toEqual({ expand: true });
    expect(explorerKeyIntent('Enter', rows, 3)).toEqual({ open: true });
    expect(explorerKeyIntent('Enter', rows, -1)).toBeNull();
  });

  test('a pinned folder has nothing to collapse: Left goes up, Enter expands it', () => {
    const pinned = [
      row('p', '', true, true),
      { ...row('p/q', 'p', true, true), pinned: true },
      row('p/q/a.md', 'p/q'),
    ];
    expect(explorerKeyIntent('h', pinned, 1)).toEqual({ focus: 'p' });
    expect(explorerKeyIntent('Enter', pinned, 1)).toEqual({ expand: true });
    expect(explorerKeyIntent('l', pinned, 1)).toEqual({ focus: 'p/q/a.md' });
  });

  test('unrelated keys are not handled', () => {
    expect(explorerKeyIntent('x', rows, 0)).toBeNull();
  });
});

describe('treeLabel', () => {
  test('a Concept with a title shows the title', () => {
    expect(treeLabel({ name: 'cm.md', path: 'cm.md', isDir: false, title: 'CodeMirror' })).toBe(
      'CodeMirror',
    );
  });

  test('a Concept without a title shows its filename stem', () => {
    expect(treeLabel({ name: 'cm.md', path: 'cm.md', isDir: false })).toBe('cm');
  });

  test('a folder shows its own name', () => {
    expect(treeLabel({ name: 'concepts', path: 'concepts', isDir: true, children: [] })).toBe(
      'concepts',
    );
  });

  const customers: TreeNode = {
    name: 'customers',
    path: 'customers',
    isDir: true,
    children: [{ name: 'index.md', path: 'customers/index.md', isDir: false, title: 'Kunden' }],
  };

  test('a folder with a titled index.md shows that title', () => {
    expect(treeLabel(customers)).toBe('Kunden');
  });

  test('titles off: filenames and folder names', () => {
    expect(treeLabel(customers, false)).toBe('customers');
    expect(treeLabel({ name: 'cm.md', path: 'cm.md', isDir: false, title: 'CodeMirror' }, false)).toBe(
      'cm',
    );
  });
});

describe('setNodeTitle', () => {
  const make = (): TreeNode => ({
    name: 'bundle',
    path: '',
    isDir: true,
    children: [
      {
        name: 'a',
        path: 'a',
        isDir: true,
        children: [{ name: 'b.md', path: 'a/b.md', isDir: false, title: 'Old' }],
      },
    ],
  });
  const leaf = (root: TreeNode) => root.children![0].children![0];

  test('sets a nested Concept title in place', () => {
    const root = make();
    expect(setNodeTitle(root, 'a/b.md', 'New')).toBe(true);
    expect(leaf(root).title).toBe('New');
  });

  test('null clears the title', () => {
    const root = make();
    setNodeTitle(root, 'a/b.md', null);
    expect('title' in leaf(root)).toBe(false);
  });

  test('an unknown path changes nothing', () => {
    const root = make();
    expect(setNodeTitle(root, 'missing.md', 'X')).toBe(false);
    expect(leaf(root).title).toBe('Old');
  });
});

describe('setNodeLifecycle', () => {
  const make = (): TreeNode => ({
    name: 'bundle',
    path: '',
    isDir: true,
    children: [{ name: 'b.md', path: 'b.md', isDir: false, status: 'draft' }],
  });
  const leaf = (root: TreeNode) => root.children![0];

  test('sets both raw keys in place', () => {
    const root = make();
    expect(setNodeLifecycle(root, 'b.md', 'deprecated', '2026-01-01T00:00:00Z')).toBe(true);
    expect(leaf(root)).toMatchObject({ status: 'deprecated', staleAfter: '2026-01-01T00:00:00Z' });
  });

  test('null clears a key', () => {
    const root = make();
    setNodeLifecycle(root, 'b.md', null, null);
    expect('status' in leaf(root)).toBe(false);
    expect('staleAfter' in leaf(root)).toBe(false);
  });

  test('an unknown path changes nothing', () => {
    const root = make();
    expect(setNodeLifecycle(root, 'missing.md', null, null)).toBe(false);
    expect(leaf(root).status).toBe('draft');
  });
});

describe('explorerTitle / folderNameClick', () => {
  const root: TreeNode = {
    name: 'bundle',
    path: '',
    isDir: true,
    children: [{ name: 'index.md', path: 'index.md', isDir: false, title: 'Knowledge Base' }],
  };
  const bare: TreeNode = { name: 'bundle', path: '', isDir: true, children: [] };

  test('the root index title names the Explorer, unless titles are off', () => {
    expect(explorerTitle(root)).toBe('Knowledge Base');
    expect(explorerTitle(root, false)).toBe('Explorer');
    expect(explorerTitle(bare)).toBe('Explorer');
    expect(explorerTitle(null)).toBe('Explorer');
  });

  test('opens the index first, then toggles once it is open', () => {
    expect(folderNameClick(root, null)).toEqual({ open: 'index.md' });
    expect(folderNameClick(root, 'other.md')).toEqual({ open: 'index.md' });
    expect(folderNameClick(root, 'index.md')).toBe('toggle');
    expect(folderNameClick(bare, null)).toBe('toggle');
  });
});
