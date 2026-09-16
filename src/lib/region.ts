// `use:region` Svelte action — wires a Region container to the focus backbone.
//
// Attaching `use:region={{ id, isVisible }}` to a Region's container element
// (a Section body, the Frontmatter Region, etc.) does three things:
//   1. registers the Region with `focus` (state/focus.svelte.ts), so directional
//      movement and the active-Region mirror know it exists,
//   2. remembers the Region's last Focused item (the element inside the
//      container that last held focus) so re-entry restores it, and
//   3. implements the Region's `focus()` entry point: re-focus the remembered
//      item when still connected, else focus the first focusable descendant, and
//      as a last resort make the container itself focusable and focus it.
//
// The Editor Region does NOT use this action — its entry point is the existing
// CodeMirror `EditorView`, registered directly in App.svelte.
//
// Kept a plain action (no rune state of its own): `isVisible` is supplied as a
// getter the action calls on demand, so it always reads the caller's live
// reactive value without the action holding a copy.

import type { Action } from 'svelte/action';
import type { RegionId } from '$lib/regionGrid';
import { focus } from '$lib/state/focus.svelte';

export interface RegionParams {
  /** Which Region this container is. */
  id: RegionId;
  /**
   * Whether there is content to focus here — FALSE only when the Region is
   * genuinely absent/empty (no open Concept, no tags). Read on demand by
   * directional movement, which skips absent/empty Regions but can reveal a
   * present-but-collapsed one. Pass a getter over reactive state, e.g.
   * `() => hasRows`.
   */
  isPresent: () => boolean;
  /**
   * Whether the Region is currently SHOWN (rendered, focusable right now) —
   * FALSE when a collapse folds it away. Effective visibility, i.e.
   * `expanded || transientlyRevealed`. Pass a getter over reactive state.
   */
  isVisible: () => boolean;
  /**
   * Transiently reveal the collapse(s) hiding this Region so focus can land in
   * it (flip the ephemeral session reveal flag). No-op / omitted when the
   * Region can never be collapse-hidden.
   */
  reveal?: () => void;
  /**
   * Whether this container is the one that OWNS the Region right now. Defaults
   * to `true`. Passed as a VALUE (not a getter) so a change re-runs the action's
   * `update` and re-registers — a getter would read nothing at evaluation time
   * and the action would never hear about the change.
   *
   * The Frontmatter Region needs this: every visible Tile renders its own
   * frontmatter, but only the ACTIVE Tile's is the Region. Gating registration
   * here (rather than with an `{#if active}` around the markup) keeps the
   * container — and the CodeMirror inside it — from being torn down and rebuilt
   * every time the user clicks into a background Tile.
   */
  enabled?: boolean;
}

/** CSS selector for natively-focusable / tabindexed descendants. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
  ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function firstFocusable(container: HTMLElement): HTMLElement | null {
  // A focusable container itself wins (e.g. a roving-tabindex list root).
  if (container.matches(FOCUSABLE)) return container;
  return container.querySelector<HTMLElement>(FOCUSABLE);
}

export const region: Action<HTMLElement, RegionParams> = (node, params) => {
  let { id, isPresent, isVisible, reveal } = params;

  // The Region's remembered Focused item: the descendant that last held focus.
  // Restored on re-entry so moving away and back returns to the same item.
  let remembered: HTMLElement | null = null;
  const onFocusIn = (e: FocusEvent) => {
    if (e.target instanceof HTMLElement && node.contains(e.target)) {
      remembered = e.target;
    }
  };
  node.addEventListener('focusin', onFocusIn);

  const focusEntry = (): boolean => {
    // Remembered item first, when still in the DOM and inside this container.
    if (remembered && node.contains(remembered) && remembered.isConnected) {
      remembered.focus();
      return true;
    }
    const first = firstFocusable(node);
    if (first) {
      first.focus();
      return true;
    }
    // Last resort: make the container itself focusable and focus it, so the
    // Region can still receive focus even with no focusable child yet.
    if (node.getAttribute('tabindex') === null) node.tabIndex = -1;
    node.focus();
    return true;
  };

  let dispose: (() => void) | null = null;
  const register = () => {
    if (dispose) return;
    dispose = focus.register(id, {
      container: node,
      focus: focusEntry,
      isPresent: () => isPresent(),
      isVisible: () => isVisible(),
      reveal: () => reveal?.(),
    });
  };
  const unregister = () => {
    dispose?.();
    dispose = null;
  };

  if (params.enabled ?? true) register();

  return {
    update(next: RegionParams) {
      // `id` is stable in practice, but keep the getters fresh so the
      // registration never goes stale across a reactive getter change.
      id = next.id;
      isPresent = next.isPresent;
      isVisible = next.isVisible;
      reveal = next.reveal;
      if (next.enabled ?? true) register();
      else unregister();
    },
    destroy() {
      node.removeEventListener('focusin', onFocusIn);
      unregister();
    },
  };
};
