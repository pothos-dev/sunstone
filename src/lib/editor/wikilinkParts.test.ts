import { describe, test, expect } from 'bun:test';
import { wikilinkAnchor, wikilinkLabel } from './wikilinkParts';

describe('wikilinkAnchor', () => {
  test('no anchor', () => {
    expect(wikilinkAnchor('note')).toBeNull();
    expect(wikilinkAnchor('note|alias')).toBeNull();
  });
  test('anchor before the alias', () => {
    expect(wikilinkAnchor('note#Setup')).toBe('Setup');
    expect(wikilinkAnchor('note#Setup|alias')).toBe('Setup');
  });
  test('anchor after the alias is kept', () => {
    expect(wikilinkAnchor('note|alias#Setup')).toBe('Setup');
  });
  test('blank anchor is none', () => {
    expect(wikilinkAnchor('note#')).toBeNull();
    expect(wikilinkAnchor('note#  ')).toBeNull();
  });
});

describe('wikilinkLabel', () => {
  test('the written name, as typed', () => {
    expect(wikilinkLabel('My Note', 'a/my-note.md')).toBe('My Note');
    expect(wikilinkLabel(' note#Setup', 'note.md')).toBe('note');
    expect(wikilinkLabel('note.md', 'note.md')).toBe('note.md');
  });
  test('a same-file anchor falls back to the basename', () => {
    expect(wikilinkLabel('#Setup', 'dir/Page.MD')).toBe('Page');
  });
});
