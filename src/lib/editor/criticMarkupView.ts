import {
  EditorView,
  Decoration,
  gutter,
  GutterMarker,
  hoverTooltip,
  type DecorationSet,
  type Tooltip,
} from '@codemirror/view';
import { RangeSet, StateField, type EditorState, type Extension } from '@codemirror/state';
import { parseCriticMarks, pairAnnotations, type Annotation } from '$lib/wasm/exports';
import { changeMarkDecorations } from './criticMarkup';

// ---------------------------------------------------------------------------
// CriticMarkup annotation rendering (feat/criticmarkup-annotations)
//
// Embedded CriticMarkup highlight+comment annotations rendered OUT of the text
// flow, mirroring the broken-links.ts / wiki-links.ts extension shape:
//   - Highlight (`{==text==}`): the content gets a highlighter background; the
//     `{==` / `==}` delimiters are hidden.
//   - Comment (`{>>note<<}`, bound to a preceding highlight): hidden from the
//     text flow entirely, surfaced instead as a LEFT-gutter icon on the line
//     and a hover tooltip over the highlighted text.
//   - Reveal-on-cursor: when the selection/caret is inside an annotation's span,
//     the raw markup is shown (delimiters/comment NOT hidden) so it can be
//     edited or deleted — exactly like wiki-links.ts reveals raw source. The
//     highlight background stays on the content even when revealed.
//
// Slice A also renders the track-change marks — addition (`{++…++}`, green),
// deletion (`{--…--}`, red) and substitution (`{~~old~>new~~}`, red `old` span
// immediately followed by a green `new` span) — reusing the same delimiter-
// hiding + reveal-on-cursor behaviour. Their decoration computation lives in the
// pure `changeMarkDecorations` helper; this module maps it to tint marks.
//
// The pure parsing / pairing / editing logic lives in `criticMarkup.ts`; this
// module is the thin CodeMirror wiring over it. Parsing the whole doc per
// recompute is fine for v1 (annotations are sparse and docs modest).
// ---------------------------------------------------------------------------

const highlightMark = Decoration.mark({ class: 'cm-critic-highlight' });
const hideMark = Decoration.replace({});
// Track-change marks (Slice A): removed text tinted red, new text tinted green.
const delMark = Decoration.mark({ class: 'cm-critic-del' });
const addMark = Decoration.mark({ class: 'cm-critic-add' });

/**
 * Is the selection touching this annotation's overall span (inclusive)? When
 * true we reveal the raw markup so the user can edit/delete it — the same
 * cursor-inside reveal wiki-links.ts uses for links.
 */
function isRevealed(state: EditorState, ann: Annotation): boolean {
  return state.selection.ranges.some((r) => r.from <= ann.to && r.to >= ann.from);
}

/**
 * Build the annotation decoration set: highlight backgrounds always, delimiter/
 * comment replacements only while the annotation is NOT revealed. Uses
 * `Decoration.set(array, true)` (sorted for us) because replace + mark land at
 * adjacent offsets and a hand-ordered builder would be fragile. Zero-length
 * ranges are skipped — `Decoration.replace` over an empty range is invalid.
 */
function computeDecorations(state: EditorState, allowReveal: boolean): DecorationSet {
  const marks = parseCriticMarks(state.doc.toString());
  const anns = pairAnnotations(marks);
  const decos: { from: number; to: number; value: Decoration }[] = [];
  for (const ann of anns) {
    // Reading mode never reveals raw markup (allowReveal=false): the cursor-inside
    // reveal is a hybrid/live-editing affordance, not a reading one.
    const revealed = allowReveal && isRevealed(state, ann);
    const { highlight, comment } = ann;
    if (highlight) {
      if (highlight.contentFrom < highlight.contentTo) {
        decos.push({ from: highlight.contentFrom, to: highlight.contentTo, value: highlightMark });
      }
      if (!revealed) {
        if (highlight.from < highlight.contentFrom) {
          decos.push({ from: highlight.from, to: highlight.contentFrom, value: hideMark });
        }
        if (highlight.contentTo < highlight.to) {
          decos.push({ from: highlight.contentTo, to: highlight.to, value: hideMark });
        }
      }
    }
    if (comment && !revealed && comment.from < comment.to) {
      decos.push({ from: comment.from, to: comment.to, value: hideMark });
    }
  }
  // Track-change marks (addition/deletion/substitution). Computed by the pure helper so the
  // reveal-on-cursor / delimiter-hiding logic stays unit-testable; mapped to the tint marks here.
  const selections = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  for (const d of changeMarkDecorations(marks, selections, allowReveal)) {
    const value = d.kind === 'del' ? delMark : d.kind === 'add' ? addMark : hideMark;
    decos.push({ from: d.from, to: d.to, value });
  }
  return Decoration.set(
    decos.map((d) => d.value.range(d.from, d.to)),
    true,
  );
}

/**
 * The decoration StateField: recomputes on doc / selection changes (selection
 * matters because the cursor-inside reveal toggles the delimiters). A StateField
 * — NOT a ViewPlugin — because a comment note may contain line breaks, and a
 * `Decoration.replace` that spans a line boundary is only permitted from a state
 * field (a plugin providing one throws, dropping all annotation rendering back to
 * raw markup and aborting the dispatch). Parsing the whole doc per recompute is
 * fine for v1 (annotations are sparse), so no viewport dependency is needed.
 */
function makeCriticDecorations(allowReveal: boolean): Extension {
  return StateField.define<DecorationSet>({
    create(state) {
      return computeDecorations(state, allowReveal);
    },
    update(deco, tr) {
      if (tr.docChanged || tr.selection) return computeDecorations(tr.state, allowReveal);
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

// ---------------------------------------------------------------------------
// Left gutter: a small speech-bubble icon on lines carrying a commented
// annotation (bound or point comment). Clicking it parks the caret in the note.
// ---------------------------------------------------------------------------

const COMMENT_ICON_SVG =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M2.5 2.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6.6L3.7 14a.5.5 0 0 1-.85-.35V11.5H2.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z"/>' +
  '</svg>';

/**
 * Called when a comment gutter icon is clicked: the host opens the annotation
 * popup to edit the note. `anchor` is a stable position INSIDE the annotation
 * (its comment start) so the host can re-find it after re-parsing; `text` is the
 * current note; `x`/`y` are viewport coords to anchor the popup near the icon.
 */
export type CommentEditRequest = { anchor: number; text: string; x: number; y: number };
export type OnCommentEdit = (req: CommentEditRequest) => void;

class CriticCommentMarker extends GutterMarker {
  constructor(readonly title: string) {
    super();
  }
  eq(other: CriticCommentMarker): boolean {
    return other.title === this.title;
  }
  toDOM(): Node {
    const span = document.createElement('span');
    span.className = 'cm-critic-gutter-icon';
    span.innerHTML = COMMENT_ICON_SVG;
    // Native hover fallback + accessibility label for the note text.
    span.title = this.title;
    return span;
  }
}

/** All commented annotations (bound or point comment) in the current doc. */
function commentedAnnotations(view: EditorView): Annotation[] {
  return pairAnnotations(parseCriticMarks(view.state.doc.toString())).filter(
    (a) => a.comment !== null,
  );
}

/**
 * One gutter marker per line that holds a commented annotation. Multiple
 * annotations on a line are deduped by keeping the first (its title on the
 * icon). Built as a sorted `RangeSet` keyed by line start.
 */
function gutterMarkers(view: EditorView): RangeSet<GutterMarker> {
  const seenLines = new Set<number>();
  const ranges: { from: number; value: GutterMarker }[] = [];
  for (const ann of commentedAnnotations(view)) {
    const line = view.state.doc.lineAt(ann.from);
    if (seenLines.has(line.from)) continue;
    seenLines.add(line.from);
    ranges.push({ from: line.from, value: new CriticCommentMarker(ann.comment?.text ?? '') });
  }
  return RangeSet.of(
    ranges.map((r) => r.value.range(r.from)),
    true,
  );
}

/** The commented annotation on the doc line containing `pos`, or null. */
function annotationOnLine(view: EditorView, pos: number): Annotation | null {
  const lineFrom = view.state.doc.lineAt(pos).from;
  for (const ann of commentedAnnotations(view)) {
    if (view.state.doc.lineAt(ann.from).from === lineFrom) return ann;
  }
  return null;
}

/**
 * The comment gutter. Clicking a marker opens the annotation popup (via
 * `onCommentEdit`) so the note is edited in a text input rather than the raw
 * `{>>...<<}` markup — this works in reading mode too, the preferred way to
 * annotate. When no callback is wired (defensive), it falls back to parking the
 * caret in the note so raw editing still has an entry point.
 */
function makeCriticGutter(onCommentEdit?: OnCommentEdit): Extension {
  return gutter({
    class: 'cm-critic-gutter',
    markers: (view) => gutterMarkers(view),
    domEventHandlers: {
      mousedown(view, line, event) {
        const ann = annotationOnLine(view, line.from);
        if (!ann) return false;
        if (onCommentEdit) {
          const anchor = ann.comment?.from ?? ann.highlight?.from ?? line.from;
          const e = event as MouseEvent;
          onCommentEdit({ anchor, text: ann.comment?.text ?? '', x: e.clientX, y: e.clientY });
          return true;
        }
        // Fallback: no popup wired — park the caret in the note for raw editing.
        const target = ann.comment?.contentFrom ?? ann.highlight?.contentFrom;
        if (target == null) return false;
        view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
        view.focus();
        return true;
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Hover tooltip: show the bound note over the highlighted text.
// ---------------------------------------------------------------------------

const criticTooltip = hoverTooltip((view, pos): Tooltip | null => {
  const anns = pairAnnotations(parseCriticMarks(view.state.doc.toString()));
  for (const ann of anns) {
    const { highlight, comment } = ann;
    if (!highlight || !comment) continue;
    if (highlight.contentFrom <= pos && pos <= highlight.contentTo) {
      return {
        pos: highlight.contentFrom,
        end: highlight.contentTo,
        above: true,
        create() {
          const dom = document.createElement('div');
          dom.className = 'cm-critic-tooltip';
          dom.textContent = comment.text ?? '';
          return { dom };
        },
      };
    }
  }
  return null;
});

/**
 * Bundle the CriticMarkup annotation extensions: the decoration StateField, the
 * comment gutter and the hover tooltip. Wire this into the non-`edit` modes so
 * source mode keeps raw `{==...==}` visible (see `modeExtensions` in cm.ts).
 * `reading` (view mode) disables the cursor-inside reveal so clicking a marked
 * span never exposes raw markup — that affordance is for hybrid/live editing.
 */
export function criticMarkupAnnotations(reading: boolean, onCommentEdit?: OnCommentEdit): Extension {
  return [makeCriticDecorations(!reading), makeCriticGutter(onCommentEdit), criticTooltip];
}

/**
 * Styling for the CriticMarkup annotations, referencing Sunstone's design
 * tokens (app.css) so it tracks light/dark for free. The highlighter background
 * is a warm translucent amber (not a token — annotation-specific), scoped per
 * theme so it stays legible on both papers; everything else maps to existing
 * surface/border/text tokens. A static theme, harmless in every mode.
 */
export const criticMarkupTheme: Extension = EditorView.theme({
  // atomic-editor's theme hides gutters wholesale (`.cm-gutters{display:none}`)
  // since the live-preview editor is otherwise gutterless. Re-show the container
  // ONLY when a comment icon is actually rendered (`:has(...-icon)`), so a doc
  // with no annotations keeps the gutter fully hidden — the feature has zero
  // layout footprint when inactive. Kept chrome-free (no background/border).
  '.cm-gutters:has(.cm-critic-gutter-icon)': {
    display: 'flex',
    backgroundColor: 'transparent',
    border: 'none',
  },
  '.cm-critic-highlight': {
    backgroundColor: 'rgba(255, 208, 0, 0.35)',
    borderRadius: '2px',
    padding: '0 1px',
  },
  '&[data-theme="dark"] .cm-critic-highlight': {
    backgroundColor: 'rgba(255, 196, 64, 0.22)',
  },
  // Track-change tints (Slice A). Annotation-specific red/green — like the amber highlight
  // above, these are NOT design tokens; they are scoped per theme so both papers stay legible.
  // Explicitly no strikethrough / underline: that vocabulary is reserved for real markdown.
  '.cm-critic-del': {
    color: '#b3261e',
    backgroundColor: 'rgba(179, 38, 30, 0.12)',
    borderRadius: '2px',
    padding: '0 1px',
    textDecoration: 'none',
  },
  '.cm-critic-add': {
    color: '#1a7f37',
    backgroundColor: 'rgba(26, 127, 55, 0.14)',
    borderRadius: '2px',
    padding: '0 1px',
    textDecoration: 'none',
  },
  '&[data-theme="dark"] .cm-critic-del': {
    color: '#f2b8b5',
    backgroundColor: 'rgba(248, 81, 73, 0.20)',
  },
  '&[data-theme="dark"] .cm-critic-add': {
    color: '#7ee787',
    backgroundColor: 'rgba(63, 185, 80, 0.20)',
  },
  '.cm-critic-gutter': {
    minWidth: '26px',
    // Breathing room from the viewport's left edge so the icon isn't jammed
    // against it (the live-preview editor is otherwise gutterless).
    paddingLeft: '8px',
  },
  '.cm-critic-gutter-icon': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: 'var(--text-faint)',
    cursor: 'pointer',
    transition: 'color 0.12s ease',
  },
  '.cm-critic-gutter-icon:hover': {
    color: 'var(--accent)',
  },
  '.cm-critic-tooltip': {
    maxWidth: '320px',
    padding: '6px 8px',
    backgroundColor: 'var(--bg-elevated)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    boxShadow: 'var(--shadow-md)',
    fontFamily: 'var(--font-ui)',
    fontSize: '0.82rem',
    lineHeight: '1.4',
    whiteSpace: 'pre-wrap',
  },
});
