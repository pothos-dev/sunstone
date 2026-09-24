// Explorer keyboard-navigation state (slice: explorer-keyboard-nav).
//
// Owns the Explorer's Focused item — the keyboard cursor, a tree row — which is
// INDEPENDENT of the open Concept (docs/GLOSSARY.md "Focused item"): arrowing moves
// the Focused item without opening anything; only Enter opens. The open Concept
// keeps its filled-accent marker; the Focused item shows the spotlight ring.
//
// This store holds ONLY the Focused-item path as a rune and the pure
// key-handling logic (delegating index math to `$lib/treeNav`). It is DOM-free:
// ExplorerPane.svelte drives DOM focus from `focusedPath` via roving tabindex + an
// effect, and supplies the side-effecting callbacks (open a Concept + move focus
// to the Editor, toggle a folder's expanded state). Keeping it here mirrors the
// other `.svelte.ts` stores and keeps App's keydown wiring thin.

import {
  flattenVisible,
  indexOfPath,
  nextIndexClamped,
  prevIndexClamped,
  type VisibleRow,
} from '$lib/treeNav';
import type { TreeNode } from '$lib/types';
import { isPlainKey } from '$lib/keynav';

/** Side-effects the handler invokes; supplied by ExplorerPane.svelte. */
export interface ExplorerNavActions {
  /** Whether a folder path is currently expanded. */
  isExpanded: (path: string) => boolean;
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
   * `actions` supplies expansion + open side-effects. Movement uses the
   * flattened VISIBLE rows and CLAMPS at the ends (see `$lib/treeNav`).
   *
   * `h/j/k/l` are unmodified here — unambiguous because cross-Region movement is
   * `Alt`+`hjkl` (handled by App's global capture handler, which runs first).
   */
  handleKeydown(e: KeyboardEvent, root: TreeNode | null, actions: ExplorerNavActions): boolean {
    // Never claim modified chords: those belong to the global handler (Alt =
    // Region move, Ctrl/Cmd = palettes/undo). Only plain keys navigate the tree.
    if (!isPlainKey(e)) return false;

    const rows = flattenVisible(root, actions.isExpanded);
    if (rows.length === 0) return false;

    const current = indexOfPath(rows, this.focusedPath);
    const row: VisibleRow | undefined = current >= 0 ? rows[current] : undefined;

    switch (e.key) {
      case 'ArrowDown':
      case 'j': {
        this.focusedPath = rows[nextIndexClamped(current, rows.length)].path;
        return true;
      }
      case 'ArrowUp':
      case 'k': {
        this.focusedPath = rows[prevIndexClamped(current, rows.length)].path;
        return true;
      }
      case 'Home': {
        this.focusedPath = rows[0].path;
        return true;
      }
      case 'End': {
        this.focusedPath = rows[rows.length - 1].path;
        return true;
      }
      case 'ArrowRight':
      case 'l': {
        if (!row) {
          this.focusedPath = rows[0].path;
          return true;
        }
        if (row.isDir) {
          if (!row.expanded) {
            // collapsed folder → expand in place
            actions.setExpanded(row.path, true);
          } else {
            // expanded folder → move into its first child (the next row, which
            // is this folder's first descendant when there is one)
            const next = rows[current + 1];
            if (next && next.parentPath === row.path) this.focusedPath = next.path;
          }
        }
        // file → no-op
        return true;
      }
      case 'ArrowLeft':
      case 'h': {
        if (!row) {
          this.focusedPath = rows[0].path;
          return true;
        }
        if (row.isDir && row.expanded) {
          // expanded folder → collapse
          actions.setExpanded(row.path, false);
        } else if (row.parentPath !== '') {
          // file, or collapsed folder → jump to the parent folder (when the
          // parent is itself a visible row; root-level rows have no parent row)
          this.focusedPath = row.parentPath;
        }
        return true;
      }
      case 'Enter':
      case ' ': {
        // Space mirrors Enter (native button affordance, matching the Tags
        // browser): toggle a folder's expansion, or open a Concept on a file.
        if (!row) return false;
        if (row.isDir) {
          actions.setExpanded(row.path, !row.expanded);
        } else {
          // file → open the Concept AND move focus to the Editor
          actions.openConcept(row.path);
        }
        return true;
      }
      default:
        return false;
    }
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
