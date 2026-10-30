// Pure global-hotkey router for App.svelte's window keydown handler. Maps a
// KeyboardEvent (plus the minimal context flags the inline handler used to
// read from reactive state / the DOM) to an intent; App keeps a thin
// dispatcher switch that performs the side effects. Branch ORDER mirrors the
// original inline chain exactly — it is load-bearing (e.g. Ctrl+Shift+F must
// win over Ctrl+F, review-Escape over the unified peel).

import { directionForKey, type Direction } from './regionGrid';
import { commandForEvent, type Keybindings } from './settings/keybindings';

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
  /** DOM focus is inside the Frontmatter Region's YAML editor — a local layer
   *  to peel (back to the Region container) before the Region backbone acts. */
  frontmatterEditing: boolean;
  /** The quick-nav overlay is open. */
  quickNavOpen: boolean;
  /** The quick-nav tag drill-down is active (a local peel layer). */
  quickNavTagActive: boolean;
  /** The Bundle switcher exists in this shell (desktop only, never on web). */
  bundleSwitcher: boolean;
  /** The effective shortcuts (`settings.keybindings`): the rebindable app
   *  commands route by these, not by fixed keys. */
  keybindings: Keybindings;
}

export type AppHotkeyIntent =
  | { kind: 'toggle-quicknav' }
  | { kind: 'toggle-search' }
  | { kind: 'toggle-bundle-switcher' }
  | { kind: 'toggle-settings' }
  | { kind: 'print' }
  | { kind: 'find' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'history-back' }
  | { kind: 'history-forward' }
  | { kind: 'exit-review' }
  /** UI zoom: Ctrl/Cmd with `+`/`-`/`0`. Caller preventDefaults. */
  | { kind: 'zoom'; step: 'in' | 'out' | 'reset' }
  /** The unified Escape peel: caller runs `focus.escape(localPeelActive)` and
   *  preventDefaults only when it reports having peeled a layer. */
  | { kind: 'escape'; localPeelActive: boolean }
  /** Alt+arrow Region/tile movement: caller preventDefaults, tries the editor
   *  tile grid first (when the editor Region is focused), then the backbone. */
  | { kind: 'move'; dir: Direction };

/** Map a Ctrl/Cmd zoom chord to its step, or null when it isn't one. */
function zoomStepForKey(e: KeyboardEvent): 'in' | 'out' | 'reset' | null {
  if ((!e.ctrlKey && !e.metaKey) || e.altKey) return null;
  if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') return 'in';
  if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') return 'out';
  if (e.key === '0' || e.code === 'Numpad0') return 'reset';
  return null;
}

const plainEscape = (e: KeyboardEvent): boolean =>
  e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;

/**
 * Route a global keydown to an intent, or `null` when App should do nothing
 * (letting the browser / CodeMirror handle the key).
 */
export function routeAppHotkey(e: KeyboardEvent, ctx: AppHotkeyContext): AppHotkeyIntent | null {
  // UI zoom. Layout-independent: `+` needs Shift on most layouts and `=` does
  // not, so Shift is allowed here (unlike the keybindings' exact matching).
  // The numpad variants are accepted via `code`.
  const zoomStep = zoomStepForKey(e);
  if (zoomStep !== null) return { kind: 'zoom', step: zoomStep };

  // The rebindable commands, by the user's keybindings (`settings/keybindings.ts`).
  // A command whose context does not hold leaves the key to the browser.
  switch (commandForEvent(e, ctx.keybindings, 'app')) {
    case 'quickNav':
      return { kind: 'toggle-quicknav' };
    case 'search':
      return { kind: 'toggle-search' };
    case 'settings':
      return { kind: 'toggle-settings' };
    // Bundle switcher: desktop only — on web the key stays the browser's.
    case 'switchBundle':
      return ctx.bundleSwitcher ? { kind: 'toggle-bundle-switcher' } : null;
    // Export as PDF: the clean print/PDF preview for the active Concept.
    case 'print':
      return ctx.conceptOpen ? { kind: 'print' } : null;
    // In-Concept Find.
    case 'find':
      return ctx.conceptOpen ? { kind: 'find' } : null;
    // Browser-style history on the active Tile.
    case 'back':
      return { kind: 'history-back' };
    case 'forward':
      return { kind: 'history-forward' };
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

  // Review mode owns Escape first: exit the active Tile's review view.
  if (plainEscape(e) && ctx.reviewActive) return { kind: 'exit-review' };

  // Escape: the UNIFIED peel — one layer per press, innermost first.
  if (plainEscape(e)) {
    const frontmatterPeel = ctx.focusedRegion === 'frontmatter' && ctx.frontmatterEditing;
    const editorPeel = ctx.focusedRegion === 'editor';
    const quickNavTagPeel = ctx.quickNavOpen && ctx.quickNavTagActive;
    return { kind: 'escape', localPeelActive: frontmatterPeel || editorPeel || quickNavTagPeel };
  }

  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const dir = directionForKey(e.key);
  if (dir !== null) return { kind: 'move', dir };
  return null;
}
