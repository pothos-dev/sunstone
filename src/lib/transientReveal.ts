// Pure decision logic for transient Region auto-reveal
// (slice: transient-region-auto-reveal). DOM-free and state-free so it is
// unit-testable; the rune-based session store (state/session.svelte.ts) holds
// the ephemeral flags and applies these decisions.
//
// A Region can be hidden for two different reasons during directional movement:
//   - by a COLLAPSE (the content exists, just folded away) → auto-reveal it,
//   - ABSENT / EMPTY (nothing to focus) → skip it.
// The reveal flips an ephemeral `transientlyRevealed` flag at the level that was
// hidden (a whole Sidebar and/or one Section). Visible = `expanded ||
// transientlyRevealed`. Focus leaving the Region clears the transient flags,
// snapping back to the persisted `expanded` state.

import type { RegionId } from '$lib/regionGrid';

/**
 * The ephemeral transient-reveal flags, keyed at the same granularity as the
 * persisted collapse flags (each Sidebar + each Section). The session store has
 * one `$state<boolean>` rune per entry, all defaulting to `false`.
 */
export type TransientFlag =
  | 'leftSidebarRevealed'
  | 'rightSidebarRevealed'
  | 'explorerRevealed'
  | 'tagsRevealed'
  | 'outlineRevealed'
  | 'backlinksRevealed';

export const ALL_TRANSIENT_FLAGS: readonly TransientFlag[] = [
  'leftSidebarRevealed',
  'rightSidebarRevealed',
  'explorerRevealed',
  'tagsRevealed',
  'outlineRevealed',
  'backlinksRevealed',
];

/**
 * The transient flags that keep `region` shown — i.e. the ones that must be
 * PRESERVED when focus lands in `region` while every other peeked Region is
 * snapped back. A Sidebar Section needs both its Sidebar's flag and its own
 * Section flag; the Regions that can never be collapse-hidden — Properties (now
 * gated by the global show/hide toggle, not a collapse) and the Editor — keep
 * none. Empty for an unknown id (total + safe).
 */
export function revealFlagsFor(region: RegionId): readonly TransientFlag[] {
  switch (region) {
    case 'explorer':
      return ['leftSidebarRevealed', 'explorerRevealed'];
    case 'tags':
      return ['leftSidebarRevealed', 'tagsRevealed'];
    case 'outline':
      return ['rightSidebarRevealed', 'outlineRevealed'];
    case 'backlinks':
      return ['rightSidebarRevealed', 'backlinksRevealed'];
    case 'frontmatter':
    case 'editor':
      return [];
  }
}

/**
 * Given the Region focus just landed in, return the set of transient flags to
 * CLEAR (snap back to persisted) — every flag except those keeping `entered`
 * shown. Pure; the session store applies the result.
 */
export function flagsToClearOnEnter(entered: RegionId): readonly TransientFlag[] {
  const keep = new Set<TransientFlag>(revealFlagsFor(entered));
  return ALL_TRANSIENT_FLAGS.filter((f) => !keep.has(f));
}
