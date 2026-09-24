import { test, expect } from 'bun:test';
import { tileTitle, tileHeaderLabel, windowTitle, folderCrumbs, foldersToExpand } from './tileTitle';

test('tileTitle: empty when nothing is open', () => {
  expect(tileTitle(null, '')).toBe('');
});

test('tileTitle: prefers a non-empty frontmatter title', () => {
  expect(tileTitle('concepts/codemirror.md', 'title: CodeMirror 6\n')).toBe('CodeMirror 6');
});

test('tileTitle: falls back to the filename stem when no title', () => {
  expect(tileTitle('concepts/editor/live-preview.md', 'type: Concept\n')).toBe('live-preview');
  expect(tileTitle('concepts/editor/live-preview.md', '')).toBe('live-preview');
});

test('tileTitle: falls back when the title is blank/whitespace', () => {
  expect(tileTitle('concepts/bundle.md', 'title: "   "\n')).toBe('bundle');
});

test('tileTitle: ignores a non-scalar title', () => {
  expect(tileTitle('concepts/bundle.md', 'title: [a, b]\n')).toBe('bundle');
});

test('tileTitle: falls back while the block does not parse', () => {
  expect(tileTitle('concepts/bundle.md', 'title: ok\n  bad: [1, 2\n')).toBe('bundle');
});

test('tileTitle: root-level Concept uses its stem', () => {
  expect(tileTitle('index.md', '')).toBe('index');
});

test('tileHeaderLabel: folder prefix carries a trailing slash', () => {
  expect(tileHeaderLabel('concepts/editor/live-preview.md', '')).toMatchObject({
    dir: 'concepts/editor/',
    name: 'live-preview',
  });
});

test('tileHeaderLabel: prefix is the PATH even when the name comes from frontmatter', () => {
  expect(tileHeaderLabel('concepts/codemirror.md', 'title: CodeMirror 6\n')).toMatchObject({
    dir: 'concepts/',
    name: 'CodeMirror 6',
  });
});

test('tileHeaderLabel: a root-level Concept has no prefix', () => {
  expect(tileHeaderLabel('index.md', '')).toMatchObject({ dir: '', name: 'index' });
});

test('tileHeaderLabel: empty Tile has neither prefix nor name', () => {
  expect(tileHeaderLabel(null, '')).toMatchObject({ dir: '', name: '' });
});

test('windowTitle: app name alone when nothing is open', () => {
  expect(windowTitle(null, '')).toBe('Sunstone');
});

test('windowTitle: Concept title then app name', () => {
  expect(windowTitle('concepts/codemirror.md', 'title: CodeMirror 6\n')).toBe('CodeMirror 6 — Sunstone');
  expect(windowTitle('concepts/bundle.md', '')).toBe('bundle — Sunstone');
});

test('folderCrumbs: one crumb per ancestor folder, outermost first', () => {
  expect(folderCrumbs('concepts/editor')).toEqual([
    { name: 'concepts', folder: 'concepts' },
    { name: 'editor', folder: 'concepts/editor' },
  ]);
  expect(folderCrumbs('')).toEqual([]);
});

test('tileHeaderLabel: carries the folder crumbs', () => {
  expect(tileHeaderLabel('concepts/editor/live-preview.md', '').crumbs.map((c) => c.folder)).toEqual([
    'concepts',
    'concepts/editor',
  ]);
  expect(tileHeaderLabel(null, '').crumbs).toEqual([]);
});

test('foldersToExpand: the folder and each ancestor', () => {
  expect(foldersToExpand('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
});
