// Explorer keyboard-navigation state (slice: explorer-keyboard-nav).
//
// Owns the Explorer's Focused item — the keyboard cursor, a tree row — which is
// INDEPENDENT of the open Concept (docs/GLOSSARY.md "Focused item"): arrowing moves
// the Focused item without opening anything; only Enter opens. The open Concept
// keeps its filled-accent marker; the Focused item shows the spotlight ring.
//
// This store holds ONLY the Focused-item path as a rune and the key-handling
// glue (the key decision is the pure `explorerKeyIntent` in `$lib/treeNav`). It
// is DOM-free: ExplorerPane.svelte drives DOM focus from `focusedPath` via
// roving tabindex + an effect, and supplies the side-effecting callbacks (open a Concept + move focus
// to the Editor, toggle a folder's expanded state). Keeping it here mirrors the
// other `.svelte.ts` stores and keeps App's keydown wiring thin.

import { explorerKeyIntent, flattenVisible, indexOfPath } from '$lib/treeNav';
import type { TreeNode } from '$lib/types';
import { isPlainKey } from '$lib/keynav';

/** Side-effects the handler invokes; supplied by ExplorerPane.svelte. */
export interface ExplorerNavActions {
  /** Whether a folder path is currently expanded (its own, persisted state). */
  isExpanded: (path: string) => boolean;
  /** Whether a folder is held open by the open Concept (`treeNav.holdsPath`). */
  isPinned?: (path: string) => boolean;
  /** Set a folder's expanded state (persists via the session store). */
  setExpanded: (path: string, expanded: boolean) => void;
  /** Open a Concept and move focus to the Editor (Enter on a file row). */
  openConcept: (path: string) => void;
}

/**
 * CRUD-dialog triggers the Focused-item key handler invokes; supplied by
 * ExplorerPane.svelte (slice: explorer-crud-keybindings). Each fires the SAME existing
 * `TreeCrud` dialog the right-click context menu opens, targeting `path` (the
 * current Focused item). The new-target rule (inside a folder vs. sibling of a
 * file) is applied by TreeCrud's existing `childDirOf`, so these just hand it
 * the Focused item's path.
 */
export interface ExplorerCrudActions {
  rename: (path: string) => void;
  remove: (path: string) => void;
  newConcept: (path: string) => void;
  newFolder: (path: string) => void;
  move: (path: string) => void;
}

class ExplorerNavStore {
  /**
   * bundle-relative path of the Focused item (the roving-tabindex tree row), or
   * null when nothing is focused yet. Set by arrowing, clicking a row, or Home/
   * End; NOT tied to the open Concept.
   */
  focusedPath = $state<string | null>(null);

  /** Make `path` the Focused item (e.g. on click or programmatic focus). */
  setFocused(path: string): void {
    this.focusedPath = path;
  }

  /**
   * Handle a within-Explorer keydown. Returns true when the key was handled (the
   * caller should then `preventDefault`). `root` is the Bundle-root node and
   * `actions` supplies expansion + open side-effects. The key decision is the
   * pure `explorerKeyIntent` over the flattened VISIBLE rows (see
   * `$lib/treeNav`); this applies it.
   *
   * `h/j/k/l` are unmodified here — unambiguous because cross-Region movement is
   * `Alt`+`hjkl` (handled by App's global capture handler, which runs first).
   */
  handleKeydown(e: KeyboardEvent, root: TreeNode | null, actions: ExplorerNavActions): boolean {
    // Never claim modified chords: those belong to the global handler (Alt =
    // Region move, Ctrl/Cmd = palettes/undo). Only plain keys navigate the tree.
    if (!isPlainKey(e)) return false;

    const rows = flattenVisible(root, actions.isExpanded, actions.isPinned);
    if (rows.length === 0) return false;

    const current = indexOfPath(rows, this.focusedPath);
    const intent = explorerKeyIntent(e.key, rows, current);
    if (!intent) return false;
    if (intent.focus !== undefined) this.focusedPath = intent.focus;
    if (intent.expand !== undefined) actions.setExpanded(rows[current].path, intent.expand);
    // file → open the Concept AND move focus to the Editor
    if (intent.open) actions.openConcept(rows[current].path);
    return true;
  }

  /**
   * Handle a CRUD letter key on the Focused item (slice:
   * explorer-crud-keybindings). Fires the existing TreeCrud dialogs:
   *   r / F2 → rename, d / Delete → delete, a → New Concept,
   *   A (Shift+a) → New Folder, m → move.
   * Returns true when the key was handled (caller then `preventDefault`s).
   *
   * Runs AFTER `handleKeydown` in App's tree-tile handler. These are UNMODIFIED
   * keys, EXCEPT the one deliberate Shift exception (`A` = Shift+a → New
   * Folder); any other Ctrl/Alt/Meta/Shift chord is left for the global handler.
   * No-ops when nothing is focused — there is no target item.
   */
  handleCrudKeydown(e: KeyboardEvent, actions: ExplorerCrudActions): boolean {
    // Ctrl/Alt/Meta belong to the global handler (Region move / palettes / undo).
    if (e.altKey || e.ctrlKey || e.metaKey) return false;

    const path = this.focusedPath;
    if (path === null) return false;

    // Shift is only ever allowed for the deliberate `A` (Shift+a) → New Folder
    // exception; reject every other Shift chord so it can't trigger a verb.
    if (e.shiftKey) {
      if (e.key === 'A') {
        actions.newFolder(path);
        return true;
      }
      return false;
    }

    switch (e.key) {
      case 'r':
      case 'F2':
        actions.rename(path);
        return true;
      case 'd':
      case 'Delete':
        actions.remove(path);
        return true;
      case 'a':
        actions.newConcept(path);
        return true;
      case 'm':
        actions.move(path);
        return true;
      default:
        return false;
    }
  }
}

export const explorerNav = new ExplorerNavStore();
