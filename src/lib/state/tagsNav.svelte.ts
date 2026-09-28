// Tags Section keyboard-navigation state (slice: tags-multi-expand-keyboard-nav).
//
// Owns the Tags Region's Focused item — the keyboard cursor, a row in the
// two-level Tags tree (a tag root or a tagged-Concept leaf; docs/GLOSSARY.md "Focused
// item"). Like the Explorer, arrowing moves the Focused item without opening
// anything; only Enter on a leaf opens the Concept (and moves focus to the
// Editor). Tags has NO CRUD verbs — tags derive from frontmatter, so there is
// nothing to create/rename/delete here.
//
// This store holds ONLY the Focused-item key as a rune and the key-handling glue
// (the key decision is the pure `tagKeyIntent` in `$lib/tagsNav`). It is
// DOM-free: TagBrowser.svelte drives DOM focus from `focusedKey` via roving
// tabindex + an effect, and supplies the side-effecting callbacks. Keeping it here mirrors `explorerNav`/`listFocusNav`.

import { flattenTagRows, indexOfKey, tagKeyIntent } from '$lib/tagsNav';
import type { TagCount } from '$lib/types';
import { isPlainKey } from '$lib/keynav';

/** Side-effects the handler invokes; supplied by TagBrowser.svelte. */
export interface TagsNavActions {
  /** Whether a tag is currently expanded. */
  isExpanded: (tag: string) => boolean;
  /** Set a tag's expanded state (drives the multi-expand Set + the per-tag query). */
  setExpanded: (tag: string, expanded: boolean) => void;
  /** Open a Concept and move focus to the Editor (Enter on a concept leaf). */
  openConcept: (path: string) => void;
}

class TagsNavStore {
  /**
   * Stable key of the Focused row (the roving-tabindex row), or null when
   * nothing is focused yet. A tag root is keyed by its tag, a concept leaf by
   * `tag path` (see `$lib/tagsNav.rowKey`). Set by arrowing, clicking a row, or
   * Home/End; NOT tied to the open Concept.
   */
  focusedKey = $state<string | null>(null);

  /** Make the row with `key` the Focused item (e.g. on click or programmatic focus). */
  setFocused(key: string): void {
    this.focusedKey = key;
  }

  /**
   * Handle a within-Tags keydown. Returns true when the key was handled (the
   * caller should then `preventDefault`). `tags` is the current tag list and
   * `actions` supplies expand + open side-effects. The key decision is the pure
   * `tagKeyIntent` over the flattened VISIBLE rows (see `$lib/tagsNav`); this
   * applies it.
   *
   * `h/j/k/l` are unmodified here — unambiguous because cross-Region movement is
   * `Alt`+`hjkl` (handled by App's global capture handler, which runs first).
   * There are deliberately NO CRUD verbs in Tags.
   */
  handleKeydown(
    e: KeyboardEvent,
    tags: TagCount[],
    conceptsOf: (tag: string) => string[],
    actions: TagsNavActions,
  ): boolean {
    // Never claim modified chords: those belong to the global handler (Alt =
    // Region move, Ctrl/Cmd = palettes). Only plain keys navigate the tree.
    if (!isPlainKey(e)) return false;

    const rows = flattenTagRows(tags, actions.isExpanded, conceptsOf);
    if (rows.length === 0) return false;

    const current = indexOfKey(rows, this.focusedKey);
    const intent = tagKeyIntent(e.key, rows, current);
    if (!intent) return false;
    if (intent.focus !== undefined) this.focusedKey = intent.focus;
    if (intent.expand !== undefined) actions.setExpanded(rows[current].tag, intent.expand);
    // concept leaf → open the Concept AND move focus to the Editor
    if (intent.open) actions.openConcept(rows[current].path);
    return true;
  }
}

export const tagsNav = new TagsNavStore();
