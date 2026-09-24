// Flat-list keyboard-navigation state for the Outline and Backlinks Regions
// (slice: outline-backlinks-keyboard-nav).
//
// Both Regions are flat, read-only, navigate-and-open lists (docs/GLOSSARY.md
// "Outline" / "Backlinks"). Each owns a Focused item — the keyboard cursor, a
// roving-tabindex list item — moved by the arrow/jk keys and activated by Enter.
// Unlike the Explorer the Focused item here is a plain list index over the
// rendered entries; there is no tree to flatten.
//
// This store holds ONLY the Focused index as a rune plus the pure key-handling
// logic (delegating clamp index math to `$lib/treeNav`, which is generic — NOT
// `$lib/listNav`, which WRAPS for modal palettes). It is DOM-free: `listRegionNav`
// (wired from App.svelte) drives DOM focus from `focusedIndex` via roving
// tabindex + an effect, and App supplies the side-effecting `activate` callback
// (scroll the Editor / open the Concept, then move focus to the Editor).
// Keeping it here mirrors `explorerNav` and keeps App's keydown wiring thin.
//
// Two instances are exported (`outlineNav`, `backlinksNav`) so the Outline and
// Backlinks Regions navigate independently, each remembering its own position.

import { nextIndexClamped, prevIndexClamped } from '$lib/treeNav';
import { isPlainKey } from '$lib/keynav';

class ListFocusNavStore {
  /**
   * Zero-based index of the Focused item among the Region's rendered entries,
   * or null when nothing is focused yet. Set by arrowing, clicking an entry, or
   * Home/End. Clamped to the list bounds when the list shrinks (see `clamp`).
   */
  focusedIndex = $state<number | null>(null);

  /** Make `index` the Focused item (e.g. on click or programmatic focus). */
  setFocused(index: number): void {
    this.focusedIndex = index;
  }

  /**
   * Re-clamp the Focused index into `[0, length)` after the list changes (the
   * open Concept switched, headings/backlinks recomputed). Clears it to null
   * when the list is now empty so re-entry lands on the first item. Called from
   * the component whenever its entry count changes.
   */
  clamp(length: number): void {
    if (this.focusedIndex === null) return;
    if (length === 0) {
      this.focusedIndex = null;
    } else if (this.focusedIndex > length - 1) {
      this.focusedIndex = length - 1;
    }
  }

  /**
   * Handle a within-Region keydown over a flat list of `length` items. Returns
   * true when the key was handled (the caller should then `preventDefault`).
   * `activate` is the per-Region Enter action (scroll-to-heading + focus Editor
   * for the Outline; open-Concept for Backlinks). Movement CLAMPS at the ends
   * (see `$lib/treeNav`).
   *
   * `j/k` are unmodified here — unambiguous because cross-Region movement is
   * `Alt`+`hjkl` (handled by App's global capture handler, which runs first).
   */
  handleKeydown(e: KeyboardEvent, length: number, activate: (index: number) => void): boolean {
    // Never claim modified chords: those belong to the global handler (Alt =
    // Region move, Ctrl/Cmd = palettes/undo). Only plain keys navigate the list.
    if (!isPlainKey(e)) return false;
    if (length === 0) return false;

    const current = this.focusedIndex ?? -1;

    switch (e.key) {
      case 'ArrowDown':
      case 'j': {
        this.focusedIndex = nextIndexClamped(current, length);
        return true;
      }
      case 'ArrowUp':
      case 'k': {
        this.focusedIndex = prevIndexClamped(current, length);
        return true;
      }
      case 'Home': {
        this.focusedIndex = 0;
        return true;
      }
      case 'End': {
        this.focusedIndex = length - 1;
        return true;
      }
      case 'Enter': {
        if (current < 0) return false;
        activate(current);
        return true;
      }
      default:
        return false;
    }
  }
}

/** The Outline Region's keyboard-navigation state. */
export const outlineNav = new ListFocusNavStore();
/** The Backlinks Region's keyboard-navigation state. */
export const backlinksNav = new ListFocusNavStore();
