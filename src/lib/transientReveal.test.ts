import { describe, expect, test } from 'bun:test';
import {
  ALL_TRANSIENT_FLAGS,
  revealFlagsFor,
  flagsToClearOnEnter,
} from './transientReveal';

describe('revealFlagsFor', () => {
  test('a collapse-hideable left Region needs its Sidebar + Section flags', () => {
    expect(revealFlagsFor('explorer')).toEqual([
      'leftSidebarRevealed',
      'explorerRevealed',
    ]);
    expect(revealFlagsFor('tags')).toEqual(['leftSidebarRevealed', 'tagsRevealed']);
  });

  test('a collapse-hideable right Region needs its Sidebar + Section flags', () => {
    expect(revealFlagsFor('outline')).toEqual([
      'rightSidebarRevealed',
      'outlineRevealed',
    ]);
    expect(revealFlagsFor('backlinks')).toEqual([
      'rightSidebarRevealed',
      'backlinksRevealed',
    ]);
  });

  test('the never-collapse-hidden Regions (Properties, Editor) keep no flags', () => {
    // Properties is now gated by the global show/hide toggle (not a collapse),
    // so it has no transient reveal flag; the Editor never collapses either.
    expect(revealFlagsFor('frontmatter')).toEqual([]);
    expect(revealFlagsFor('editor')).toEqual([]);
  });

  test('every named flag is one of the known flags', () => {
    const known = new Set(ALL_TRANSIENT_FLAGS);
    for (const id of ['explorer', 'tags', 'outline', 'backlinks', 'frontmatter'] as const) {
      for (const f of revealFlagsFor(id)) expect(known.has(f)).toBe(true);
    }
  });
});

describe('flagsToClearOnEnter', () => {
  test('entering the never-collapsible Editor clears EVERY transient reveal', () => {
    // This is the re-collapse case: leaving a peeked Region for the Editor must
    // snap everything back (no flag survives).
    expect(new Set(flagsToClearOnEnter('editor'))).toEqual(new Set(ALL_TRANSIENT_FLAGS));
  });

  test('entering the Properties Region clears every peek (it has no flag of its own)', () => {
    // Properties is gated by the global toggle now, not a transient reveal, so
    // landing focus there simply snaps back every OTHER peeked Region.
    const cleared = flagsToClearOnEnter('frontmatter');
    expect(cleared).toContain('leftSidebarRevealed');
    expect(cleared).toContain('rightSidebarRevealed');
  });

  test('entering a peeked Region preserves exactly its own reveal flags', () => {
    // The clear runs on the focusin caused by focusing the just-revealed Region;
    // its own flags must survive so it does not re-collapse under itself.
    const cleared = flagsToClearOnEnter('explorer');
    expect(cleared).not.toContain('leftSidebarRevealed');
    expect(cleared).not.toContain('explorerRevealed');
    // A different peeked Region's flags ARE cleared (e.g. a stale right-side peek).
    expect(cleared).toContain('rightSidebarRevealed');
    expect(cleared).toContain('backlinksRevealed');
    expect(cleared).toContain('tagsRevealed');
  });

  test('clear ∪ keep partitions the full flag set with no overlap', () => {
    for (const id of [
      'explorer',
      'tags',
      'outline',
      'backlinks',
      'editor',
      'frontmatter',
    ] as const) {
      const keep = new Set(revealFlagsFor(id));
      const clear = new Set(flagsToClearOnEnter(id));
      // Disjoint.
      for (const f of clear) expect(keep.has(f)).toBe(false);
      // Together they cover every flag.
      expect(new Set([...keep, ...clear])).toEqual(new Set(ALL_TRANSIENT_FLAGS));
    }
  });
});
