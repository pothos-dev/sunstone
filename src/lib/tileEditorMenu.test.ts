import { describe, it, expect } from 'bun:test';
import { buildEditorMenuItems, editorCommandFor } from './tileEditorMenu';
import {
  cutSelection,
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleInlineCode,
  insertOrEditLink,
} from './editor/commands';

describe('buildEditorMenuItems', () => {
  it('read-only with no annotate action opens no menu', () => {
    const result = buildEditorMenuItems({
      readOnly: true,
      hasSelection: false,
      annotateAction: null,
      linkAction: null,
    });
    expect(result.items).toEqual([]);
    expect(result.annotateUsesSelectionRange).toBe(false);
  });

  it('read-only with an "add" annotate action offers only Add comment, using the selection range', () => {
    const result = buildEditorMenuItems({
      readOnly: true,
      hasSelection: true,
      annotateAction: 'add',
      linkAction: null,
    });
    expect(result.items).toEqual([{ id: 'annotate', label: 'Add comment' }]);
    expect(result.annotateUsesSelectionRange).toBe(true);
  });

  it('read-only with a "remove" annotate action offers only Remove comment, no selection range', () => {
    const result = buildEditorMenuItems({
      readOnly: true,
      hasSelection: false,
      annotateAction: 'remove',
      linkAction: null,
    });
    expect(result.items).toEqual([{ id: 'annotate', label: 'Remove comment' }]);
    expect(result.annotateUsesSelectionRange).toBe(false);
  });

  it('editing with no selection: cut/copy/formatting are omitted', () => {
    const result = buildEditorMenuItems({
      readOnly: false,
      hasSelection: false,
      annotateAction: null,
      linkAction: 'insert',
    });
    expect(result.items).toEqual([
      { id: 'paste', label: 'Paste' },
      { id: 'link', label: 'Insert link', separated: true },
    ]);
  });

  it('editing with a selection: cut/copy and formatting toggles appear', () => {
    const result = buildEditorMenuItems({
      readOnly: false,
      hasSelection: true,
      annotateAction: null,
      linkAction: 'insert',
    });
    expect(result.items).toEqual([
      { id: 'cut', label: 'Cut' },
      { id: 'copy', label: 'Copy' },
      { id: 'paste', label: 'Paste' },
      { id: 'bold', label: 'Bold', separated: true },
      { id: 'italic', label: 'Italic' },
      { id: 'strike', label: 'Strikethrough' },
      { id: 'code', label: 'Inline code' },
      { id: 'link', label: 'Insert link', separated: true },
    ]);
  });

  it('editing over an existing link: link item labeled "Edit link"', () => {
    const result = buildEditorMenuItems({
      readOnly: false,
      hasSelection: false,
      annotateAction: null,
      linkAction: 'edit',
    });
    expect(result.items.find((i) => i.id === 'link')).toEqual({
      id: 'link',
      label: 'Edit link',
      separated: true,
    });
  });

  it('editing with an available annotate action appends it, separated', () => {
    const result = buildEditorMenuItems({
      readOnly: false,
      hasSelection: true,
      annotateAction: 'add',
      linkAction: 'insert',
    });
    expect(result.items[result.items.length - 1]).toEqual({
      id: 'annotate',
      label: 'Add comment',
      separated: true,
    });
    expect(result.annotateUsesSelectionRange).toBe(true);
  });

  it('editing with a "remove" annotate action does not use the selection range', () => {
    const result = buildEditorMenuItems({
      readOnly: false,
      hasSelection: true,
      annotateAction: 'remove',
      linkAction: 'insert',
    });
    expect(result.annotateUsesSelectionRange).toBe(false);
  });
});

describe('editorCommandFor', () => {
  it('maps the formatting/link ids straight to their editor commands', () => {
    expect(editorCommandFor('bold')).toBe(toggleBold);
    expect(editorCommandFor('italic')).toBe(toggleItalic);
    expect(editorCommandFor('strike')).toBe(toggleStrikethrough);
    expect(editorCommandFor('code')).toBe(toggleInlineCode);
    expect(editorCommandFor('link')).toBe(insertOrEditLink);
  });

  it('maps the clipboard ids to fire-and-forget wrappers of the async commands', () => {
    for (const id of ['cut', 'copy', 'paste']) {
      const cmd = editorCommandFor(id);
      expect(typeof cmd).toBe('function');
    }
    // Identity is intentionally NOT the async command itself: the wrapper
    // discards the promise, exactly as Tile.svelte's old switch did.
    expect(editorCommandFor('cut')).not.toBe(cutSelection);
  });

  it('returns null for annotate (Tile-owned) and unknown ids', () => {
    expect(editorCommandFor('annotate')).toBeNull();
    expect(editorCommandFor('nope')).toBeNull();
    expect(editorCommandFor('toString')).toBeNull();
    expect(editorCommandFor('hasOwnProperty')).toBeNull();
  });
});
