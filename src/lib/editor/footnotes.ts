import {
  EditorView,
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { scanFootnotes, footnoteDefPos } from '$lib/wasm/exports';
import { jumpFlashField, jumpAndFlash } from './jumpFlash';

// ---------------------------------------------------------------------------
// Footnotes (ov-14)
//
// A `[^label]` reference renders as a superscript `[label]` link; a click
// scrolls to its `[^label]:` definition and flashes that line, the same jump
// the `[n]` citations make (the shared `jumpFlash`). A reference with no
// definition renders as broken and does nothing. A definition's `[^label]:`
// marker renders as a `[label]` row head. Labels show as written: Sunstone
// does not renumber footnotes.
//
// Recognition is the shared Rust `scan_footnotes` (over wasm); this module is
// the thin CodeMirror layer. Modes follow `citations.ts`: reading always
// renders; hybrid shows the raw reference under the cursor, and the raw
// definition marker while the cursor is on its line.
// ---------------------------------------------------------------------------

/** Superscript standing in for a `[^label]` reference. */
class FootnoteRefWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly defined: boolean,
  ) {
    super();
  }
  eq(other: FootnoteRefWidget): boolean {
    return other.label === this.label && other.defined === this.defined;
  }
  toDOM(): HTMLElement {
    const sup = document.createElement('sup');
    sup.className = this.defined ? 'cm-footnote-ref' : 'cm-footnote-ref cm-footnote-broken';
    sup.textContent = `[${this.label}]`;
    sup.dataset.footnote = this.label;
    if (this.defined) {
      sup.setAttribute('role', 'link');
      sup.setAttribute('aria-label', `Footnote ${this.label}`);
      sup.title = `Jump to footnote ${this.label}`;
    } else {
      sup.title = `Footnote ${this.label} has no definition`;
    }
    return sup;
  }
  // Let clicks reach our DOM handler rather than being swallowed as an atom.
  ignoreEvent(): boolean {
    return false;
  }
}

/** Row head standing in for a definition's `[^label]:` marker. */
class FootnoteDefWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(other: FootnoteDefWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-footnote-def';
    span.textContent = `[${this.label}]`;
    return span;
  }
}

function computeFootnotes(view: EditorView, reading: boolean): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc, selection } = view.state;
  const revealCursor = !reading && view.hasFocus;
  for (const f of scanFootnotes(doc.toString())) {
    if (revealCursor) {
      const touched = f.def
        ? selection.ranges.some((r) => {
            const line = doc.lineAt(f.from);
            return r.from <= line.to && r.to >= line.from;
          })
        : selection.ranges.some((r) => r.from <= f.to && r.to >= f.from);
      if (touched) continue; // show the raw marker for editing.
    }
    const widget = f.def
      ? new FootnoteDefWidget(f.label)
      : new FootnoteRefWidget(f.label, f.defined);
    builder.add(f.from, f.to, Decoration.replace({ widget }));
  }
  return builder.finish();
}

/** Route a click on a defined reference to its definition. */
const footnoteClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null;
    const el = target?.closest?.('.cm-footnote-ref') as HTMLElement | null;
    const label = el?.dataset.footnote;
    if (!label) return false;
    event.preventDefault();
    const pos = footnoteDefPos(view.state.doc.toString(), label);
    if (pos != null) jumpAndFlash(view, pos);
    return true;
  },
});

/** The footnote extension for a render mode (see `citations`). */
export function footnotes(reading: boolean): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = computeFootnotes(view, reading);
        }
        update(update: ViewUpdate) {
          if (
            update.docChanged ||
            update.viewportChanged ||
            update.selectionSet ||
            update.focusChanged
          ) {
            this.decorations = computeFootnotes(update.view, reading);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
    jumpFlashField,
    footnoteClick,
  ];
}

/** Footnote reference + definition styling (static, like `citationTheme`). */
export const footnoteTheme = EditorView.theme({
  '.cm-footnote-ref': {
    color: 'var(--accent)',
    cursor: 'pointer',
    fontWeight: '600',
    fontSize: '0.72em',
    padding: '0 0.05em',
  },
  '.cm-footnote-ref:hover': {
    textDecoration: 'underline',
  },
  '.cm-footnote-ref.cm-footnote-broken': {
    color: 'var(--danger)',
    cursor: 'default',
    textDecoration: 'underline dashed var(--danger)',
    textUnderlineOffset: '2px',
  },
  '.cm-footnote-def': {
    color: 'inherit',
    fontWeight: '600',
  },
});
