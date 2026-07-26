import { test, expect } from 'bun:test';
import { syncNoticeText } from './syncNotice';

// The exact wording of the two divergence notices (git-sync spec §10.2). These
// strings are the spec's, verbatim — the `.svelte` notice slot renders this
// helper's output and inlines nothing.

test('a forked notice names the canonical path and the fork', () => {
  expect(
    syncNoticeText({
      kind: 'forked',
      path: 'notes/foo.md',
      fork: 'notes/foo-20260726T101500Z.md',
    }),
  ).toBe('A conflicting copy of notes/foo.md was saved as notes/foo-20260726T101500Z.md');
});

test('a dropped-deletion notice says the file was modified on origin', () => {
  expect(syncNoticeText({ kind: 'deletionDropped', path: 'notes/foo.md' })).toBe(
    'Deletion of notes/foo.md was reverted — it was modified on origin.',
  );
});

test('neither message is personal — the notice goes to every client', () => {
  const messages = [
    syncNoticeText({ kind: 'forked', path: 'a.md', fork: 'a-20260726T101500Z.md' }),
    syncNoticeText({ kind: 'deletionDropped', path: 'a.md' }),
  ];
  for (const message of messages) {
    expect(message.toLowerCase()).not.toContain('your');
    expect(message.toLowerCase()).not.toContain(' my ');
  }
});

test('paths pass through verbatim (nested folders, non-.md)', () => {
  expect(
    syncNoticeText({ kind: 'forked', path: 'a/b/c.txt', fork: 'a/b/c-20260101T000000Z.txt' }),
  ).toBe('A conflicting copy of a/b/c.txt was saved as a/b/c-20260101T000000Z.txt');
  expect(syncNoticeText({ kind: 'deletionDropped', path: 'a/b/index.md' })).toBe(
    'Deletion of a/b/index.md was reverted — it was modified on origin.',
  );
});
