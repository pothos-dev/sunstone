import { EditorView, type Command } from '@codemirror/view';
import { parseCriticMarks, pairAnnotations, annotationAt } from '$lib/wasm/exports';
import {
  insertHighlightComment,
  removeAnnotation,
  setCommentText,
} from './criticMarkup';
import { headingFormatEdit, toggleInlineWrap, insertLink, linkAt } from './textFormat';

/**
 * A CM command that toggles an inline wrap (`**`, `*`, `` ` ``, `~~`) around the
 * current selection via the pure `toggleInlineWrap` transform. No-op in
 * read-only (reading-view) mode, where it declines the key so it can fall
 * through. Selecting the inner text afterwards keeps the formatted run highlighted.
 */
export function inlineWrapCommand(marker: string): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const { from, to } = view.state.selection.main;
    const edit = toggleInlineWrap(view.state.doc.toString(), from, to, marker);
    view.dispatch({ changes: edit.changes, selection: edit.selection, scrollIntoView: true });
    return true;
  };
}

/**
 * A CM command that toggles ATX heading `level` (1–6, or 0 for "plain
 * paragraph") across the lines the selection touches, via `headingFormatEdit`.
 * The selection is remapped through the changes by CodeMirror. No-op in
 * read-only mode.
 */
export function headingCommand(level: number): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const { from, to } = view.state.selection.main;
    const edit = headingFormatEdit(view.state.doc.toString(), from, to, level);
    if (edit.changes.length > 0) view.dispatch({ changes: edit.changes, scrollIntoView: true });
    return true;
  };
}

/**
 * What the annotate toggle would do for the current selection:
 *   - `'add'`    — wrap the selection as an annotation.
 *   - `'remove'` — strip the annotation under an empty caret.
 *   - `null`     — no-op: read-only, an empty caret outside any annotation, or a
 *                  selection overlapping an existing annotation (no nesting).
 * Shared by `annotateCommand` (which then acts) and the right-click menu (which
 * uses it to decide whether to offer the item and how to label it).
 */
export function annotateActionFor(view: EditorView): 'add' | 'remove' | null {
  // NOT readOnly-gated: annotating works in reading mode too (the preferred way),
  // where the popup applies the change programmatically. The RANGE comes from
  // `selectionForAnnotate`, which falls back to the DOM selection when CodeMirror
  // does not sync it (non-editable reading mode).
  const { from, to } = selectionForAnnotate(view);
  const anns = pairAnnotations(parseCriticMarks(view.state.doc.toString()));
  if (from === to) return annotationAt(anns, from) ? 'remove' : null;
  // A selection overlapping an existing annotation can't be wrapped (no nesting).
  return anns.some((a) => from <= a.to && to >= a.from) ? null : 'add';
}

/**
 * The range to annotate: the state selection when it is non-empty, else — in
 * reading mode, where CodeMirror does not sync the non-editable DOM selection —
 * the browser's text selection mapped back to document offsets via `posAtDOM`.
 * Returns a collapsed range (from === to) when there is nothing selected.
 */
export function selectionForAnnotate(view: EditorView): { from: number; to: number } {
  const sel = view.state.selection.main;
  if (sel.from !== sel.to) return { from: sel.from, to: sel.to };
  const dom = typeof window !== 'undefined' ? window.getSelection() : null;
  if (dom && dom.rangeCount > 0 && !dom.isCollapsed && dom.anchorNode && dom.focusNode) {
    try {
      const a = view.posAtDOM(dom.anchorNode, dom.anchorOffset);
      const b = view.posAtDOM(dom.focusNode, dom.focusOffset);
      if (a !== b) return { from: Math.min(a, b), to: Math.max(a, b) };
    } catch {
      /* selection outside the editor content — fall through */
    }
  }
  return { from: sel.from, to: sel.to };
}

/**
 * A CM command that TOGGLES a CriticMarkup highlight+comment annotation over the
 * selection, via the pure `criticMarkup` transforms. See `annotateActionFor` for
 * the branching; on `'add'` it wraps the selection as `{==sel==}{>><<}` and parks
 * the caret inside the empty comment so the user types the note.
 */
export const annotateCommand: Command = (view) => {
  // Raw-authoring keybinding: it parks the caret in the note to type, so it needs
  // an editable buffer. Reading mode annotates via the popup instead (see App).
  if (view.state.readOnly) return false;
  const action = annotateActionFor(view);
  if (!action) return false;
  const doc = view.state.doc.toString();
  const { from, to } = view.state.selection.main;
  if (action === 'remove') {
    const at = annotationAt(pairAnnotations(parseCriticMarks(doc)), from);
    if (!at) return false;
    view.dispatch({ changes: removeAnnotation(doc, at).changes, scrollIntoView: true });
    return true;
  }
  const edit = insertHighlightComment(doc, from, to);
  if (!edit) return false;
  view.dispatch({
    changes: edit.changes,
    selection: edit.cursor != null ? { anchor: edit.cursor } : undefined,
    scrollIntoView: true,
  });
  return true;
};

/**
 * Run the annotate toggle imperatively (from the editor's right-click menu),
 * refocusing the editor afterwards. Mirrors the keybinding path. No-op when
 * `annotateActionFor` says there is nothing to do.
 */
export function annotate(view: EditorView): void {
  annotateCommand(view);
  view.focus();
}

/**
 * Imperative annotation authoring for the popup (App.svelte). All three dispatch
 * changes PROGRAMMATICALLY, so they apply even in reading (read-only) mode — the
 * preferred way to annotate — and the change listener autosaves the result.
 */

/** Wrap [from,to) as an annotation carrying `comment`. No-op for an empty range. */
export function addAnnotationWithComment(
  view: EditorView,
  from: number,
  to: number,
  comment: string,
): void {
  const edit = insertHighlightComment(view.state.doc.toString(), from, to, comment);
  if (!edit) return;
  view.dispatch({ changes: edit.changes, scrollIntoView: true });
}

/**
 * Set the note of the annotation covering `anchor` to `text`. The doc is
 * re-parsed so a shifted range is re-found; empty `text` removes the whole
 * annotation (an emptied note is a deleted annotation).
 */
export function updateAnnotationComment(view: EditorView, anchor: number, text: string): void {
  const doc = view.state.doc.toString();
  const ann = annotationAt(pairAnnotations(parseCriticMarks(doc)), anchor);
  if (!ann) return;
  const edit = text.trim() === '' ? removeAnnotation(doc, ann) : setCommentText(doc, ann, text);
  if (edit.changes.length === 0) return;
  view.dispatch({ changes: edit.changes, scrollIntoView: true });
}

/** Strip the annotation covering `anchor`, keeping the highlighted text (the popup's Remove). */
export function removeAnnotationAt(view: EditorView, anchor: number): void {
  const doc = view.state.doc.toString();
  const ann = annotationAt(pairAnnotations(parseCriticMarks(doc)), anchor);
  if (!ann) return;
  view.dispatch({ changes: removeAnnotation(doc, ann).changes, scrollIntoView: true });
}

/**
 * Imperative inline-format toggles for the editor's right-click menu, mirroring
 * `annotate`: run the shared `inlineWrapCommand` transform (which is read-only
 * guarded and dispatches) then refocus the editor. One per intent so the menu
 * can call by name.
 */
export function toggleBold(view: EditorView): void {
  inlineWrapCommand('**')(view);
  view.focus();
}
export function toggleItalic(view: EditorView): void {
  inlineWrapCommand('*')(view);
  view.focus();
}
export function toggleStrikethrough(view: EditorView): void {
  inlineWrapCommand('~~')(view);
  view.focus();
}
export function toggleInlineCode(view: EditorView): void {
  inlineWrapCommand('`')(view);
  view.focus();
}

/**
 * What the link action would do for the current selection head:
 *   - `'edit'`   — the caret sits inside an existing `[text](url)` link.
 *   - `'insert'` — no link under the caret; a new link scaffold would be added.
 *   - `null`     — read-only (reading view): the menu leaves the native menu.
 * Drives the menu label ("Edit link" / "Insert link").
 */
export function linkActionFor(view: EditorView): 'insert' | 'edit' | null {
  if (view.state.readOnly) return null;
  const head = view.state.selection.main.head;
  return linkAt(view.state.doc.toString(), head) ? 'edit' : 'insert';
}

/**
 * Insert a markdown link over the selection, OR edit the one under the caret.
 * When `linkAt` matches at the selection head we SELECT that link's url range so
 * the user can retype it (EDIT); otherwise we apply `insertLink` and place its
 * caret (INSERT — see `insertLink` for the two caret-park cases). Refocuses the
 * editor afterwards. No-op in read-only (reading-view) mode.
 */
export function insertOrEditLink(view: EditorView): void {
  if (view.state.readOnly) return;
  const doc = view.state.doc.toString();
  const { from, to, head } = view.state.selection.main;
  const existing = linkAt(doc, head);
  if (existing) {
    view.dispatch({
      selection: { anchor: existing.urlFrom, head: existing.urlTo },
      scrollIntoView: true,
    });
  } else {
    const edit = insertLink(doc, from, to);
    view.dispatch({ changes: edit.changes, selection: edit.selection, scrollIntoView: true });
  }
  view.focus();
}

/**
 * Clipboard actions for the right-click menu, over the web Clipboard API
 * (`navigator.clipboard` — available in the webview and on localhost; NOT a
 * Tauri API, so it does not cross the IPC seam). CodeMirror already handles the
 * Ctrl/Cmd+C/X/V keys natively; these expose the same operations to the menu.
 * All are async (the Clipboard API is promise-based) and best-effort: if the API
 * is unavailable or denied, they no-op rather than throw. A menu click is a user
 * gesture, which satisfies the clipboard permission requirement.
 */
export async function copySelection(view: EditorView): Promise<void> {
  const { from, to } = view.state.selection.main;
  if (from === to) return; // nothing selected
  try {
    await navigator.clipboard?.writeText(view.state.sliceDoc(from, to));
  } catch {
    /* clipboard unavailable/denied — no-op */
  }
  view.focus();
}

export async function cutSelection(view: EditorView): Promise<void> {
  if (view.state.readOnly) return;
  const { from, to } = view.state.selection.main;
  if (from === to) return;
  try {
    await navigator.clipboard?.writeText(view.state.sliceDoc(from, to));
  } catch {
    return; // don't delete the text if the copy half failed
  }
  view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } });
  view.focus();
}

export async function pasteFromClipboard(view: EditorView): Promise<void> {
  if (view.state.readOnly) return;
  let text = '';
  try {
    text = (await navigator.clipboard?.readText()) ?? '';
  } catch {
    return; // clipboard read unavailable/denied
  }
  if (!text) return;
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  view.focus();
}
