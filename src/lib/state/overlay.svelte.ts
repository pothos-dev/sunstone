// Overlay-stack registration for one overlay component (slice:
// escape-peel-restore-opener). An overlay (a palette, a context menu, a dialog,
// a popup) pushes itself onto the focus store's overlay stack the moment it
// opens — capturing the opener Region so a CANCEL restores focus there — and
// drops its entry when it closes via ANY path (cancel or commit), or when the
// component is destroyed while still open, so the stack never leaks.
//
// Call it from a component's script (it registers `$effect`s). Per-component
// "reset on open" logic stays in the component; effects run in declaration
// order within one flush, so a push here still precedes any focus move the
// component queues (e.g. `queueMicrotask(() => input.focus())`).

import { focus } from '$lib/state/focus.svelte';

/**
 * Keep the overlay stack in step with `isOpen()`. `close` is the CANCEL path
 * the global Escape peel calls (it must flip whatever `isOpen` reads to false).
 */
export function useOverlay(isOpen: () => boolean, close: () => void): void {
  let id: number | null = null;

  $effect(() => {
    const open = isOpen();
    if (open && id === null) {
      id = focus.pushOverlay(close);
    } else if (!open && id !== null) {
      focus.removeOverlay(id);
      id = null;
    }
  });

  // Teardown only: an effect with no dependencies whose cleanup runs on destroy.
  $effect(() => () => {
    if (id !== null) {
      focus.removeOverlay(id);
      id = null;
    }
  });
}
