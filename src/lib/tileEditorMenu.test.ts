import { describe, it, expect } from 'bun:test';
import { buildEditorMenuItems } from './tileEditorMenu';

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
