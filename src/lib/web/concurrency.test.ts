import { test, expect } from 'bun:test';
import {
  isOwnEcho,
  routeFileChange,
  structuralOpGated,
  conflictTitle,
  updatedNoticeText,
  deletedStateText,
  leavePromptText,
  structuralPromptText,
} from './concurrency';
import type { FileChange } from '$lib/types';

const withOrigin = (clientId: string): FileChange => ({
  kind: 'modified',
  paths: ['a.md'],
  origin: { clientId, author: { name: 'Ada' } },
});

test('isOwnEcho is true only for our own clientId', () => {
  expect(isOwnEcho(withOrigin('me'), 'me')).toBe(true);
  expect(isOwnEcho(withOrigin('someone-else'), 'me')).toBe(false);
});

test('a change with no origin (external/desktop) is never our echo', () => {
  expect(isOwnEcho({ kind: 'modified', paths: ['a.md'] }, 'me')).toBe(false);
});

// --- path-match routing (ticket 08 §2-3) -----------------------------------

const change = (
  kind: FileChange['kind'],
  paths: string[],
  author?: string,
): FileChange => ({
  kind,
  paths,
  ...(author ? { origin: { clientId: 'other', author: { name: author } } } : {}),
});

test('a change to only other files → refresh (buffer untouched)', () => {
  expect(routeFileChange(change('modified', ['other.md'], 'Bob'), 'a.md', true)).toEqual({
    type: 'refresh',
  });
  // Nothing open → any change is just a refresh.
  expect(routeFileChange(change('modified', ['a.md']), null, false)).toEqual({ type: 'refresh' });
});

test('active path modified: clean → reload, dirty → conflict, with author', () => {
  expect(routeFileChange(change('modified', ['a.md'], 'Bob'), 'a.md', false)).toEqual({
    type: 'reload',
    author: 'Bob',
  });
  expect(routeFileChange(change('modified', ['a.md'], 'Bob'), 'a.md', true)).toEqual({
    type: 'conflict',
    author: 'Bob',
  });
});

test('a created event on the active path is treated as modified', () => {
  expect(routeFileChange(change('created', ['a.md']), 'a.md', false)).toEqual({
    type: 'reload',
    author: null,
  });
});

test('active path removed → deleted, carrying dirtiness (recreatable via Save)', () => {
  expect(routeFileChange(change('removed', ['a.md'], 'Bob'), 'a.md', true)).toEqual({
    type: 'deleted',
    author: 'Bob',
    dirty: true,
  });
  expect(routeFileChange(change('removed', ['a.md']), 'a.md', false)).toEqual({
    type: 'deleted',
    author: null,
    dirty: false,
  });
});

test('an external edit (no origin) reloads with a null author', () => {
  expect(routeFileChange(change('modified', ['a.md']), 'a.md', false)).toEqual({
    type: 'reload',
    author: null,
  });
});

// --- structural gate (ticket 08 §5) ----------------------------------------

test('structural gate: create exempt; rename/move/delete gate only when dirty', () => {
  expect(structuralOpGated('create', true)).toBe(false);
  expect(structuralOpGated('rename', true)).toBe(true);
  expect(structuralOpGated('move', true)).toBe(true);
  expect(structuralOpGated('delete', true)).toBe(true);
  // Clean buffer never gates.
  for (const op of ['create', 'rename', 'move', 'delete'] as const) {
    expect(structuralOpGated(op, false)).toBe(false);
  }
});

// --- user-facing copy (ticket 08 §3-5) -------------------------------------

test('conflictTitle attributes the writer, or falls back to "on disk"', () => {
  expect(conflictTitle('mistral-ai', 'Bob')).toBe('mistral-ai was changed by Bob.');
  expect(conflictTitle('mistral-ai', null)).toBe('mistral-ai was changed on disk.');
});

test('updatedNoticeText names the author, or "Updated on disk"', () => {
  expect(updatedNoticeText('Bob')).toBe('Updated by Bob');
  expect(updatedNoticeText(null)).toBe('Updated on disk');
});

test('deletedStateText names the deleter when known', () => {
  expect(deletedStateText('Bob')).toBe('This Concept was deleted (by Bob).');
  expect(deletedStateText(null)).toBe('This Concept was deleted.');
});

test('leavePromptText asks to save the named Concept', () => {
  expect(leavePromptText('mistral-ai')).toBe('Save changes to mistral-ai?');
});

test('structuralPromptText spells out the gated op verb', () => {
  expect(structuralPromptText('rename', 'B', 'A')).toBe('Save A before renaming B?');
  expect(structuralPromptText('move', 'B', 'A')).toBe('Save A before moving B?');
  expect(structuralPromptText('delete', 'B', 'A')).toBe('Save A before deleting B?');
});
