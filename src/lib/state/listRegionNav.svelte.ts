// DOM wiring for a flat-list Region's keyboard navigation (Outline, Backlinks;
// slice: outline-backlinks-keyboard-nav). `listFocusNav` holds the DOM-free
// Focused index + key logic; this binds one of its stores to a rendered list:
// the host's keydown routes into `handleKeydown`, Enter activates the Focused
// entry element, and an effect mirrors the Focused index into DOM focus while
// the Region holds focus (roving tabindex). Entries are found by their
// `data-index` stamp; `itemSelector` counts them.
//
// Call it from a component's script (it registers an `$effect`).

import type { RegionId } from '$lib/regionGrid';
import { focus } from '$lib/state/focus.svelte';
import type { outlineNav } from '$lib/state/listFocusNav.svelte';

export interface ListRegionNavOptions {
  /** The Region's Focused-index store (`outlineNav` / `backlinksNav`). */
  nav: typeof outlineNav;
  /** The Region id whose focus the DOM-focus mirror follows. */
  region: RegionId;
  /** The element hosting the rendered list (read lazily; null until bound). */
  host: () => HTMLElement | null;
  /** Selector matching every rendered entry (the list length). */
  itemSelector: string;
  /** Enter on the Focused entry. */
  activate: (entry: HTMLElement) => void;
}

/** Wire `nav` to its rendered list; returns the host's `onkeydown` handler. */
export function listRegionNav({
  nav,
  region,
  host,
  itemSelector,
  activate,
}: ListRegionNavOptions): (e: KeyboardEvent) => void {
  const entryAt = (el: HTMLElement | null, index: number) =>
    el?.querySelector<HTMLElement>(`[data-index="${index}"]`) ?? null;

  $effect(() => {
    const index = nav.focusedIndex;
    const el = host();
    if (index === null || !el) return;
    if (focus.focusedRegion !== region) return;
    const entry = entryAt(el, index);
    if (entry && document.activeElement !== entry) entry.focus();
  });

  return (e: KeyboardEvent) => {
    const el = host();
    if (!el) return;
    const count = el.querySelectorAll(itemSelector).length;
    const handled = nav.handleKeydown(e, count, (index) => {
      const entry = entryAt(host(), index);
      if (entry) activate(entry);
    });
    if (handled) e.preventDefault();
  };
}
