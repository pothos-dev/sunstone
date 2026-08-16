// Pure global-hotkey router for App.svelte's window keydown handler. Maps a
// KeyboardEvent (plus the minimal context flags the inline handler used to
// read from reactive state / the DOM) to an intent; App keeps a thin
// dispatcher switch that performs the side effects. Branch ORDER mirrors the
// original inline chain exactly — it is load-bearing (e.g. Ctrl+Shift+F must
// win over Ctrl+F, review-Escape over the unified peel).

import { matchesHotkey } from './matchesHotkey';
import { directionForKey, type Direction } from './regionGrid';

/** The context flags the router consults (all read synchronously by App at
 *  keydown time; none are stored). */
export interface AppHotkeyContext {
  /** `editor.path !== null` — a Concept is open in the active Tile. */
  conceptOpen: boolean;
  /** DOM focus is inside a CodeMirror editor (CM handles undo/redo natively). */
  inCmEditor: boolean;
  /** The active Tile's review view is showing (owns Escape first). */
  reviewActive: boolean;
  /** `focus.focusedRegion` at keydown time. */
  focusedRegion: string | null;
  /** `propertiesNav.mode !== 'nav'` — the Properties Region has a local layer
   *  to peel before the Region backbone acts. */
  propertiesEditing: boolean;
  /** The quick-nav overlay is open. */
  quickNavOpen: boolean;
  /** The quick-nav tag drill-down is active (a local peel layer). */
  quickNavTagActive: boolean;
}

export type AppHotkeyIntent =
  | { kind: 'toggle-quicknav' }
  | { kind: 'toggle-search' }
  | { kind: 'print' }
  | { kind: 'find' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'history-back' }
  | { kind: 'history-forward' }
  | { kind: 'exit-review' }
  /** The unified Escape peel: caller runs `focus.escape(localPeelActive)` and
   *  preventDefaults only when it reports having peeled a layer. */
  | { kind: 'escape'; localPeelActive: boolean }
  /** Alt+arrow Region/tile movement: caller preventDefaults, tries the editor
   *  tile grid first (when the editor Region is focused), then the backbone. */
  | { kind: 'move'; dir: Direction };

const plainEscape = (e: KeyboardEvent): boolean =>
  e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;

/**
 * Route a global keydown to an intent, or `null` when App should do nothing
 * (letting the browser / CodeMirror handle the key).
 */
export function routeAppHotkey(e: KeyboardEvent, ctx: AppHotkeyContext): AppHotkeyIntent | null {
  if (matchesHotkey(e, { key: 'k' })) return { kind: 'toggle-quicknav' };

  if (matchesHotkey(e, { key: 'f', shift: true })) return { kind: 'toggle-search' };

  // Export as PDF: Ctrl/Cmd+P opens the clean print/PDF preview for the active
  // Concept. Only when a Concept is open; otherwise let the browser handle it.
  if (matchesHotkey(e, { key: 'p' })) {
    if (!ctx.conceptOpen) return null;
    return { kind: 'print' };
  }

  // In-Concept Find: Ctrl/Cmd+F. NO-OP when no Concept is open.
  if (matchesHotkey(e, { key: 'f' })) {
    if (!ctx.conceptOpen) return null;
    return { kind: 'find' };
  }

  // Unified undo/redo: route Ctrl/Cmd+Z/Shift+Z/Y to the active Tile's history
  // unless focus is already inside a CodeMirror editor (CM handles it natively).
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const key = e.key.toLowerCase();
    const isUndo = key === 'z' && !e.shiftKey;
    const isRedo = (key === 'z' && e.shiftKey) || key === 'y';
    if (isUndo || isRedo) {
      if (ctx.inCmEditor) return null;
      return { kind: isUndo ? 'undo' : 'redo' };
    }
  }

  // Browser-style history: Ctrl+Alt+Left/Right on the active Tile.
  if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey) {
    if (e.key === 'ArrowLeft') return { kind: 'history-back' };
    if (e.key === 'ArrowRight') return { kind: 'history-forward' };
  }

  // Review mode owns Escape first: exit the active Tile's review view.
  if (plainEscape(e) && ctx.reviewActive) return { kind: 'exit-review' };

  // Escape: the UNIFIED peel — one layer per press, innermost first.
  if (plainEscape(e)) {
    const propertiesPeel = ctx.focusedRegion === 'properties' && ctx.propertiesEditing;
    const editorPeel = ctx.focusedRegion === 'editor';
    const quickNavTagPeel = ctx.quickNavOpen && ctx.quickNavTagActive;
    return { kind: 'escape', localPeelActive: propertiesPeel || editorPeel || quickNavTagPeel };
  }

  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const dir = directionForKey(e.key);
  if (dir !== null) return { kind: 'move', dir };
  return null;
}
