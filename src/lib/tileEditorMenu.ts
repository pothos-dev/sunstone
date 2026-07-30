// Pure item-building logic for the Tile editor's formatting context menu
// (extracted from Tile.svelte's openEditorMenu/onEditorMenuSelect). Decides
// WHICH items to show for the read-only vs editing branches, selection state,
// and the annotate (comment) action — no DOM/CodeMirror side effects here.

export type EditorMenuItem = { id: string; label: string; separated?: boolean };

export interface EditorMenuBuildInput {
  /** Whether the CodeMirror view is currently read-only. */
  readOnly: boolean;
  /** Whether there is a non-empty text selection. */
  hasSelection: boolean;
  /** Whether an annotate action is available, and which one. */
  annotateAction: 'add' | 'remove' | null;
  /** Whether clicking "link" would insert a new link or edit an existing one. */
  linkAction: 'insert' | 'edit' | null;
}

export interface EditorMenuBuildResult {
  /** The menu items to render, in order. Empty means "don't open the menu". */
  items: EditorMenuItem[];
  /** Whether the annotate item (if present) should carry the current selection
   *  range (i.e. it will ADD a new comment on that range). */
  annotateUsesSelectionRange: boolean;
}

/**
 * Build the formatting context-menu items for the Tile editor.
 *
 * Read-only Tiles only ever offer the annotate action (add/remove comment),
 * and only when one is available; otherwise the menu should not open at all
 * (empty `items`). Editing Tiles offer cut/copy (when there's a selection),
 * paste, formatting toggles (when there's a selection), insert/edit link, and
 * the annotate action (when available).
 */
export function buildEditorMenuItems(input: EditorMenuBuildInput): EditorMenuBuildResult {
  const { readOnly, hasSelection, annotateAction, linkAction } = input;

  if (readOnly) {
    if (!annotateAction) return { items: [], annotateUsesSelectionRange: false };
    return {
      items: [
        {
          id: 'annotate',
          label: annotateAction === 'add' ? 'Add comment' : 'Remove comment',
        },
      ],
      annotateUsesSelectionRange: annotateAction === 'add',
    };
  }

  const items: EditorMenuItem[] = [];
  if (hasSelection) {
    items.push({ id: 'cut', label: 'Cut' });
    items.push({ id: 'copy', label: 'Copy' });
  }
  items.push({ id: 'paste', label: 'Paste' });
  if (hasSelection) {
    items.push({ id: 'bold', label: 'Bold', separated: true });
    items.push({ id: 'italic', label: 'Italic' });
    items.push({ id: 'strike', label: 'Strikethrough' });
    items.push({ id: 'code', label: 'Inline code' });
  }
  items.push({
    id: 'link',
    label: linkAction === 'edit' ? 'Edit link' : 'Insert link',
    separated: true,
  });
  if (annotateAction) {
    items.push({
      id: 'annotate',
      label: annotateAction === 'add' ? 'Add comment' : 'Remove comment',
      separated: true,
    });
  }

  return { items, annotateUsesSelectionRange: annotateAction === 'add' };
}
