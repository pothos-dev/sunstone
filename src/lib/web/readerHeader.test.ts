import { describe, expect, test } from 'bun:test';
import type { TreeNode } from '$lib/types';
import { readerCrumbAction, readerCrumbs } from './readerHeader';

function dir(path: string, children: TreeNode[]): TreeNode {
  return { name: path.split('/').pop() ?? '', path, isDir: true, children };
}
function file(path: string, title?: string): TreeNode {
  return { name: path.split('/').pop() ?? '', path, isDir: false, ...(title ? { title } : {}) };
}

const tree = dir('', [
  dir('guide', [file('guide/index.md', 'Guide'), file('guide/topic.md'), dir('guide/deep', [file('guide/deep/a.md')])]),
  file('good.md'),
]);

describe('readerCrumbs', () => {
  test('nothing open → no crumbs', () => {
    expect(readerCrumbs(null, tree)).toEqual([]);
  });

  test('a root-level Concept has no crumbs', () => {
    expect(readerCrumbs('good.md', tree)).toEqual([]);
  });

  test('one crumb per ancestor folder, named by its index title, with its index', () => {
    expect(readerCrumbs('guide/deep/a.md', tree)).toEqual([
      { name: 'Guide', folder: 'guide', index: 'guide/index.md' },
      { name: 'deep', folder: 'guide/deep', index: null },
    ]);
  });

  test('a folder index stands for its folder, so its own folder is not a crumb', () => {
    expect(readerCrumbs('guide/index.md', tree)).toEqual([]);
  });

  test('without a tree the crumbs carry no index', () => {
    expect(readerCrumbs('guide/topic.md', null)).toEqual([{ name: 'guide', folder: 'guide', index: null }]);
  });
});

describe('readerCrumbAction', () => {
  const withIndex = { name: 'Guide', folder: 'guide', index: 'guide/index.md' };
  const bare = { name: 'deep', folder: 'guide/deep', index: null };

  test('a crumb with an index opens it', () => {
    expect(readerCrumbAction(withIndex, 'guide/topic.md', false)).toEqual({ open: 'guide/index.md', drawer: null });
    expect(readerCrumbAction(withIndex, 'guide/topic.md', true)).toEqual({ open: 'guide/index.md', drawer: null });
  });

  test('a crumb without an index only reveals; on a narrow screen it opens the Explorer drawer', () => {
    expect(readerCrumbAction(bare, 'guide/deep/a.md', false)).toEqual({ open: null, drawer: null });
    expect(readerCrumbAction(bare, 'guide/deep/a.md', true)).toEqual({ open: null, drawer: 'left' });
  });

  test('the already-open index is not re-opened; it is revealed instead', () => {
    expect(readerCrumbAction(withIndex, 'guide/index.md', true)).toEqual({ open: null, drawer: 'left' });
  });
});
