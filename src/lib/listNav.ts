// Keyboard list-navigation math for the overlay palettes (pure; no DOM/state).
//
// Owns the key → intent mapping and the activeIndex clamp + wrap-around
// arithmetic shared by the overlay palettes (QuickNav, SearchPanel, Launcher
// and their web twins). Each renders a vertical list where ↑/↓ move a
// highlighted selection (wrapping at the ends), Enter opens it, and the
// selection is clamped into range when the result set shrinks. Callers keep
// their own `$state` / `$derived` / scroll-into-view wiring (and their own
// Escape semantics) — this just removes the duplicated logic so they stay in
// lockstep.

/**
 * Clamp a desired selection index into `[0, length)` without writing back to
 * state. With no items the result is 0. This is the "effective selection" the
 * UI highlights and Enter opens, derived from the user's raw `selected` intent.
 */
export function clampIndex(selected: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(selected, length - 1);
}

/** Next index with wrap-around (last → first). Returns 0 for an empty list. */
export function nextIndex(active: number, length: number): number {
  if (length === 0) return 0;
  return (active + 1) % length;
}

/** Previous index with wrap-around (first → last). Returns 0 for an empty list. */
export function prevIndex(active: number, length: number): number {
  if (length === 0) return 0;
  return (active - 1 + length) % length;
}

/** What a palette-list keypress asks for: move the selection, open it, or nothing. */
export type ListKeyIntent = 'next' | 'prev' | 'enter';

/**
 * Map a keydown to its list intent — ArrowDown / ArrowUp / Enter, the key set
 * every overlay palette (QuickNav, SearchPanel, Launcher and their web twins)
 * shares. Anything else (Escape included, whose meaning differs per palette) is
 * `null` and left to the caller.
 */
export function listKeyIntent(e: Pick<KeyboardEvent, 'key'>): ListKeyIntent | null {
  switch (e.key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'prev';
    case 'Enter':
      return 'enter';
    default:
      return null;
  }
}

/** Step the selection one place in `dir`, wrapping (see `nextIndex` / `prevIndex`). */
export function stepIndex(dir: 'next' | 'prev', active: number, length: number): number {
  return dir === 'next' ? nextIndex(active, length) : prevIndex(active, length);
}
