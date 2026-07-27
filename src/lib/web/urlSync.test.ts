// Unit tests for the pure URL ⇄ Concept reconciliation the web App shell runs
// (`WebAppShellIsland`). The interesting property is CONVERGENCE: after applying
// an action, replaying the reconcile with the winning value must be idle — that
// is what keeps `pushState` (app → URL) and `open` (URL → app) from ping-ponging.
import { describe, expect, test } from 'bun:test';
import { conceptHref, urlSyncAction } from './urlSync';

describe('urlSyncAction', () => {
  test('an unstamped entry is marked from the app side, never navigated', () => {
    // The SSR entry we land on carries no `page.state` — stamp it with the Tile's
    // Concept so a later Back restores it.
    expect(urlSyncAction(null, undefined, 'good.md', false)).toEqual({
      kind: 'stamp',
      concept: 'good.md',
    });
    // …and so does an entry whose state a real navigation wiped (`invalidateAll`
    // resets `page.state`). Reading that as "the URL moved to nothing" would
    // navigate the Tile away from the Concept being edited.
    expect(urlSyncAction('good.md', undefined, 'good.md', false)).toEqual({
      kind: 'stamp',
      concept: 'good.md',
    });
  });

  test('is idle while both sides agree with the last synced Concept', () => {
    expect(urlSyncAction('good.md', 'good.md', 'good.md', false)).toEqual({ kind: 'idle' });
    expect(urlSyncAction(null, null, null, false)).toEqual({ kind: 'idle' });
  });

  test('app navigation writes the URL', () => {
    expect(urlSyncAction('good.md', 'good.md', 'other.md', false)).toEqual({
      kind: 'url',
      concept: 'other.md',
    });
    // Closing the Tile (nothing open) addresses the Bundle root.
    expect(urlSyncAction('good.md', 'good.md', null, false)).toEqual({ kind: 'url', concept: null });
  });

  test('URL navigation (Back/Forward) opens the Concept', () => {
    expect(urlSyncAction('other.md', 'good.md', 'other.md', false)).toEqual({
      kind: 'app',
      concept: 'good.md',
    });
    expect(urlSyncAction('good.md', null, 'good.md', false)).toEqual({ kind: 'app', concept: null });
  });

  test('the app wins when BOTH sides moved (it is the surface just interacted with)', () => {
    expect(urlSyncAction('good.md', 'from-url.md', 'from-app.md', false)).toEqual({
      kind: 'url',
      concept: 'from-app.md',
    });
  });

  test('an in-flight URL-driven open suppresses the reconcile', () => {
    // Mid-Back: `synced` is already the URL's Concept but the Tile still holds
    // the old one. Acting here would push the old URL back and undo the Back.
    expect(urlSyncAction('good.md', 'good.md', 'other.md', true)).toEqual({ kind: 'idle' });
  });

  test('converges: replaying with the winner is idle', () => {
    // app → URL: push, then `synced` becomes the app's Concept.
    expect(urlSyncAction('good.md', 'good.md', 'other.md', false)).toEqual({
      kind: 'url',
      concept: 'other.md',
    });
    expect(urlSyncAction('other.md', 'other.md', 'other.md', false)).toEqual({ kind: 'idle' });

    // URL → app: open, `synced` becomes the URL's Concept, and once the open
    // lands (app side caught up) the reconcile is idle.
    expect(urlSyncAction('other.md', 'good.md', 'other.md', false)).toEqual({
      kind: 'app',
      concept: 'good.md',
    });
    expect(urlSyncAction('good.md', 'good.md', 'good.md', false)).toEqual({ kind: 'idle' });

    // …but a CANCELLED open (dirty-leave gate) leaves the app on the old Concept,
    // so the URL is written back to it rather than the two sides drifting apart.
    expect(urlSyncAction('good.md', 'good.md', 'other.md', false)).toEqual({
      kind: 'url',
      concept: 'other.md',
    });
  });
});

describe('conceptHref', () => {
  test('maps a Concept path to its pretty URL', () => {
    expect(conceptHref('good.md')).toBe('/good');
    expect(conceptHref('research/providers/mistral-ai.md')).toBe('/research/providers/mistral-ai');
  });

  test('a folder index addresses the folder; the root index and nothing-open are /', () => {
    expect(conceptHref('providers/index.md')).toBe('/providers');
    expect(conceptHref('index.md')).toBe('/');
    expect(conceptHref(null)).toBe('/');
  });
});
