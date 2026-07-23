// CriticMarkup view/authoring helpers for the editor (ADR 0006 family 13).
//
// The PARSE half (`parseCriticMarks` / `pairAnnotations` / `annotationAt`) and
// the `CriticMark` / `Annotation` / `CriticMarkKind` types now live in Rust
// (`sunstone_shared::critic`), reached synchronously via the wasm free-export
// holder (`$lib/wasm/exports`). What stays TS is the CodeMirror-shaped half:
// the pure decoration DESCRIPTORS and the authoring CHANGE sets, thin over the
// wasm-returned offset-span structs (the ADR 0006 §4 seam). Pure and
// CodeMirror-free so it can be unit-tested over plain strings; `criticMarkupView.ts`
// maps these descriptors to `Decoration`s and `cm.ts` dispatches the edits.
//
// The five CriticMarkup mark types (delimiters carry no required inner spaces —
// `{==foo==}` and `{== foo ==}` are both valid, and any inner whitespace is kept
// verbatim as content):
//   addition      {++ text ++}
//   deletion      {-- text --}
//   substitution  {~~ old ~> new ~~}
//   comment       {>> text <<}
//   highlight      {== text ==}

import type { CriticMark, Annotation } from '$lib/wasm/exports';

/** A change set for the editor to dispatch. */
export interface CriticEdit {
  changes: { from: number; to: number; insert: string }[];
  /** Where to place the cursor after applying, or null to let the editor remap. */
  cursor: number | null;
}

/** A single decoration descriptor for a change mark (addition/deletion/substitution), independent
 *  of CodeMirror so it can be unit-tested. `kind`:
 *   - `del`  → red-tinted "removed" span (the `{--…--}` body, or a substitution's `old` half),
 *   - `add`  → green-tinted "new" span (the `{++…++}` body, or a substitution's `new` half),
 *   - `hide` → a delimiter / separator run that is replaced (hidden) while the mark is collapsed. */
export type CriticDecoKind = 'del' | 'add' | 'hide';

export interface CriticDeco {
  from: number;
  to: number;
  kind: CriticDecoKind;
}

/** A caret/selection range, forward-slash of CodeMirror's `SelectionRange` (pure, testable). */
export interface DecoRange {
  from: number;
  to: number;
}

/** True when any selection range touches [from,to] inclusively — the cursor-inside test that
 *  decides whether a mark reveals its raw markup. */
function anyRangeTouches(ranges: DecoRange[], from: number, to: number): boolean {
  return ranges.some((r) => r.from <= to && r.to >= from);
}

/**
 * Compute the track-change decorations for the addition/deletion/substitution marks among `marks`
 * (highlight/comment marks are ignored — those are handled by the annotation flow). Pure logic so
 * the decoration set can be unit-tested over plain marks; the CM view maps each descriptor to a
 * `Decoration.mark` (`del`/`add`) or `Decoration.replace` (`hide`).
 *
 * A mark is "revealed" (its raw markup shown, delimiters NOT hidden) when `allowReveal` is true AND
 * the selection touches its span — the same cursor-inside affordance the annotations use. In view
 * (reading) mode `allowReveal` is false, so marks never reveal. Zero-length spans are skipped
 * (`Decoration.replace`/`mark` over an empty range is invalid / pointless).
 */
export function changeMarkDecorations(
  marks: CriticMark[],
  selections: DecoRange[],
  allowReveal: boolean,
): CriticDeco[] {
  const decos: CriticDeco[] = [];
  for (const mark of marks) {
    const { kind, from, to, contentFrom, contentTo } = mark;
    if (kind !== 'addition' && kind !== 'deletion' && kind !== 'substitution') continue;
    const revealed = allowReveal && anyRangeTouches(selections, from, to);
    const push = (f: number, t: number, k: CriticDecoKind) => {
      if (f < t) decos.push({ from: f, to: t, kind: k });
    };
    const hideDelimiters = () => {
      if (!revealed) {
        push(from, contentFrom, 'hide');
        push(contentTo, to, 'hide');
      }
    };
    if (kind === 'addition') {
      push(contentFrom, contentTo, 'add');
      hideDelimiters();
    } else if (kind === 'deletion') {
      push(contentFrom, contentTo, 'del');
      hideDelimiters();
    } else {
      // Substitution: `old` half tinted red, then `new` half tinted green, with the `~>`
      // separator hidden between them. `deleted`/`inserted` lengths locate the split; a `~>` is
      // present iff the two halves + the 2-char separator account for the whole content.
      const dLen = mark.deleted?.length ?? 0;
      const iLen = mark.inserted?.length ?? 0;
      const hasSep = dLen + 2 + iLen === contentTo - contentFrom;
      const delTo = contentFrom + dLen;
      push(contentFrom, delTo, 'del');
      if (hasSep) {
        const insFrom = delTo + 2;
        if (!revealed) push(delTo, insFrom, 'hide'); // the `~>` separator
        push(insFrom, contentTo, 'add');
      }
      hideDelimiters();
    }
  }
  return decos;
}

/** Wrap [from,to) as a highlight followed by a comment carrying `comment` (empty by default),
 *  producing `{==<selected>==}{>><comment><<}`. With no `comment` the note is empty and the cursor
 *  is parked between `{>>` and `<<}` so it can be typed in the editor (the raw-authoring keybinding
 *  path); when the popup supplies the text up front the caller ignores the cursor. Returns null when
 *  from === to (nothing selected). */
export function insertHighlightComment(
  doc: string,
  from: number,
  to: number,
  comment = '',
): CriticEdit | null {
  if (from === to) return null;
  return {
    changes: [
      { from, to: from, insert: '{==' },
      { from: to, to, insert: `==}{>>${comment}<<}` },
    ],
    // 3 for `{==` inserted before the selection + 6 for `==}{>>` after it: the
    // start of the comment content (before `comment`).
    cursor: to + 9,
  };
}

/** Set an annotation's comment text (the popup edit path). When the annotation already carries a
 *  comment, replace its inner content in place; when it is highlight-only, append a fresh
 *  `{>><text><<}` directly after the highlight (so it binds). No-op (empty change set) for an
 *  annotation with neither a comment nor a highlight. Cursor null (let the editor remap). */
export function setCommentText(doc: string, annotation: Annotation, text: string): CriticEdit {
  const { highlight, comment } = annotation;
  if (comment) {
    return { changes: [{ from: comment.contentFrom, to: comment.contentTo, insert: text }], cursor: null };
  }
  if (highlight) {
    return { changes: [{ from: highlight.to, to: highlight.to, insert: `{>>${text}<<}` }], cursor: null };
  }
  return { changes: [], cursor: null };
}

/** Strip an annotation's markup, KEEPING the highlighted text: remove the highlight delimiters
 *  (`{==` and `==}`) and delete the entire bound comment `{>>...<<}`. For a point comment
 *  (highlight null) just delete the comment. Returns the changes; cursor null (let editor remap). */
export function removeAnnotation(doc: string, annotation: Annotation): CriticEdit {
  const changes: { from: number; to: number; insert: string }[] = [];
  const { highlight, comment } = annotation;
  if (highlight) {
    // Drop the opening `{==` and the closing `==}`, keeping the inner text.
    changes.push({ from: highlight.from, to: highlight.contentFrom, insert: '' });
    changes.push({ from: highlight.contentTo, to: highlight.to, insert: '' });
  }
  if (comment) {
    // The whole comment (delimiters + note) goes away.
    changes.push({ from: comment.from, to: comment.to, insert: '' });
  }
  return { changes, cursor: null };
}
