import { test, expect } from 'bun:test';
import { tileTitle, tileHeaderLabel } from './tileTitle';
import type { Property } from './frontmatter';

const scalar = (key: string, value: string): Property => ({ key, kind: 'scalar', scalar: value });

test('tileTitle: empty when nothing is open', () => {
  expect(tileTitle(null, [])).toBe('');
});

test('tileTitle: prefers a non-empty frontmatter title', () => {
  expect(tileTitle('concepts/codemirror.md', [scalar('title', 'CodeMirror 6')])).toBe(
    'CodeMirror 6',
  );
});

test('tileTitle: falls back to the filename stem when no title', () => {
  expect(tileTitle('concepts/editor/live-preview.md', [])).toBe('live-preview');
});

test('tileTitle: falls back when the title is blank/whitespace', () => {
  expect(tileTitle('concepts/bundle.md', [scalar('title', '   ')])).toBe('bundle');
});

test('tileTitle: ignores a non-scalar title property', () => {
  const listTitle: Property = { key: 'title', kind: 'list', list: ['a', 'b'] };
  expect(tileTitle('concepts/bundle.md', [listTitle])).toBe('bundle');
});

test('tileTitle: root-level Concept uses its stem', () => {
  expect(tileTitle('index.md', [])).toBe('index');
});

test('tileHeaderLabel: folder prefix carries a trailing slash', () => {
  expect(tileHeaderLabel('concepts/editor/live-preview.md', [])).toEqual({
    dir: 'concepts/editor/',
    name: 'live-preview',
  });
});

test('tileHeaderLabel: prefix is the PATH even when the name comes from frontmatter', () => {
  expect(tileHeaderLabel('concepts/codemirror.md', [scalar('title', 'CodeMirror 6')])).toEqual({
    dir: 'concepts/',
    name: 'CodeMirror 6',
  });
});

test('tileHeaderLabel: a root-level Concept has no prefix', () => {
  expect(tileHeaderLabel('index.md', [])).toEqual({ dir: '', name: 'index' });
});

test('tileHeaderLabel: empty Tile has neither prefix nor name', () => {
  expect(tileHeaderLabel(null, [])).toEqual({ dir: '', name: '' });
});
