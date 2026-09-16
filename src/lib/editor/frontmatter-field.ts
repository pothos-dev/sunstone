import { StateField, StateEffect, Annotation, Transaction, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { invertedEffects, isolateHistory } from '@codemirror/commands';
import { DEFAULT_FENCES, type Fences } from '$lib/frontmatter';

// ---------------------------------------------------------------------------
// Frontmatter as editor state (ADR 0008, superseding ADR 0003)
//
// The body editor's document holds ONLY the markdown body. The Concept's
// frontmatter is the raw YAML TEXT in `frontmatterField`, mirrored into the
// Frontmatter Region's own CodeMirror (`frontmatterEditor.ts`) — that editor
// shows it and the user types into it, but THIS field and this history are the
// single source of truth, so undo/redo span body and frontmatter on ONE stack.
//
// `fencesField` carries the verbatim `---` delimiter lines the block was read
// with, so a body-only edit re-emits the file byte-for-byte.
//
// Grouping: CodeMirror's history only coalesces two events when BOTH carry
// document changes, so an effect-only frontmatter transaction always opens its
// own undo step. Typing would therefore produce one step per keystroke. Instead
// the mirror pushes intermediate keystrokes with `addToHistory: false` and calls
// `commitFrontmatterGroup` on the idle pause (and on blur / save / before an
// undo / on a Concept switch), which opens ONE history entry for the whole run.
// ---------------------------------------------------------------------------

/** Replace the open Concept's frontmatter YAML (the inner block, no fences). */
export const setFrontmatter = StateEffect.define<string>();

/** Replace the verbatim `---` delimiter lines (Concept switch / reload only). */
export const setFences = StateEffect.define<Fences>();

/** Holds the open Concept's frontmatter YAML (body lives in the doc). */
export const frontmatterField = StateField.define<string>({
  create: () => '',
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFrontmatter)) value = e.value;
    return value;
  },
});

/** Holds the delimiter lines to re-fence the block with on write. */
export const fencesField = StateField.define<Fences>({
  create: () => DEFAULT_FENCES,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFences)) value = e.value;
    return value;
  },
});

/**
 * Carries the frontmatter value a grouped run of keystrokes STARTED from, so
 * the history entry that closes the group inverts back past every intermediate
 * (`addToHistory: false`) transaction rather than to the last one.
 */
export const frontmatterGroupStart = Annotation.define<string>();

/**
 * Unified undo (ADR 0008): frontmatter lives in a StateField mutated via
 * `setFrontmatter` effects, which CodeMirror's history does not know how to
 * reverse on its own. `invertedEffects` teaches it: for any transaction carrying
 * a `setFrontmatter`, register the INVERSE — a `setFrontmatter` of the PRIOR
 * value (the group start when one is annotated, else `tr.startState`) — so
 * undo/redo restore frontmatter exactly the way they restore document text.
 * Body edits are ordinary doc transactions in the same history, so one timeline
 * spans both.
 *
 * This MUST be added to the extension list AFTER `history()` (see
 * `editorExtensions`) and must stay paired with `frontmatterField` — splitting
 * the two, or re-ordering relative to `history()`, can silently break undo.
 */
export const frontmatterUndo: Extension = invertedEffects.of((tr) => {
  // Only emit an inverse when this transaction actually changes frontmatter.
  if (!tr.effects.some((e) => e.is(setFrontmatter))) return [];
  const start = tr.annotation(frontmatterGroupStart);
  return [setFrontmatter.of(start ?? tr.startState.field(frontmatterField))];
});

/**
 * Push an INTERMEDIATE frontmatter keystroke: the field (and so autosave and the
 * Tile header) sees it immediately, but it opens no history entry — the group
 * boundary does that. See the module note on grouping.
 */
export function dispatchFrontmatter(view: EditorView, yaml: string): void {
  if (view.state.field(frontmatterField) === yaml) return;
  view.dispatch({
    effects: setFrontmatter.of(yaml),
    annotations: Transaction.addToHistory.of(false),
  });
}

/**
 * Close a run of frontmatter keystrokes into ONE undo step, inverting back to
 * `groupStart` (the value the run began at). No-op when nothing changed.
 * `isolateHistory.of('full')` keeps the step discrete so it never merges with
 * adjacent body typing.
 */
export function commitFrontmatterGroup(view: EditorView, groupStart: string): void {
  const current = view.state.field(frontmatterField);
  if (current === groupStart) return;
  view.dispatch({
    effects: setFrontmatter.of(current),
    annotations: [frontmatterGroupStart.of(groupStart), isolateHistory.of('full')],
  });
}
