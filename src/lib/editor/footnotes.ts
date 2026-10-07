import {
  EditorView,
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import type { Footnote } from '$lib/wasm/exports';
import { scanFootnotes, footnoteDefPos, sourceIds } from '$lib/wasm/exports';
import { frontmatterField } from './frontmatter-field';
import { jumpFlashField, jumpAndFlash } from './jumpFlash';

// ---------------------------------------------------------------------------
// Footnotes (ov-14)
//
// A `[^label]` reference renders as a superscript `n`, its label's number by
// first reference (the label shows on hover; `1,2` for adjacent ones). A click scrolls to its
// `[^label]:` definition and flashes that line, the same jump the `[n]`
// citations make (the shared `jumpFlash`). A label that matches a
// `sources[].id` in the Frontmatter is resolved even without a body definition
// (OKF v0.2 §5.1); it has no jump target until the Sources section (ov-10). A
// label with neither renders as broken. A definition's `[^label]:` marker
// renders as an `n` row head.
//
// Recognition is the shared Rust `scan_footnotes` (over wasm); this module is
// the thin CodeMirror layer. Modes follow `citations.ts`: reading always
// renders; hybrid shows the raw reference under the cursor, and the raw
// definition marker while the cursor is on its line.
// ---------------------------------------------------------------------------

/** Superscript standing in for a `[^label]` reference. */
class FootnoteRefWidget extends WidgetType {
  constructor(readonly f: Footnote) {
    super();
  }
  eq(other: FootnoteRefWidget): boolean {
    const [a, b] = [this.f, other.f];
    return (
      a.label === b.label &&
      a.num === b.num &&
      a.defined === b.defined &&
      a.hasDef === b.hasDef &&
      a.followsRef === b.followsRef
    );
  }
  toDOM(): HTMLElement {
    const { label, num, defined, hasDef, followsRef } = this.f;
    const sup = document.createElement('sup');
    sup.className = defined ? 'cm-footnote-ref' : 'cm-footnote-ref cm-footnote-broken';
    // `1,2` rather than `12` for adjacent references.
    sup.textContent = followsRef ? `,${num}` : `${num}`;
    sup.dataset.footnote = label;
    if (hasDef) {
      sup.setAttribute('role', 'link');
      sup.setAttribute('aria-label', `Footnote ${num}: ${label}`);
      sup.title = label;
    } else if (defined) {
      sup.classList.add('cm-footnote-source');
      sup.title = label;
    } else {
      sup.title = `${label}: no definition and no matching source`;
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
  constructor(
    readonly label: string,
    readonly num: number,
  ) {
    super();
  }
  eq(other: FootnoteDefWidget): boolean {
    return other.label === this.label && other.num === this.num;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-footnote-def';
    span.textContent = `${this.num}`;
    span.title = this.label;
    return span;
  }
}

function computeFootnotes(view: EditorView, reading: boolean): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc, selection } = view.state;
  const revealCursor = !reading && view.hasFocus;
  const ids = sourceIds(view.state.field(frontmatterField, false) ?? '');
  for (const f of scanFootnotes(doc.toString(), ids)) {
    if (revealCursor) {
      const touched = f.def
        ? selection.ranges.some((r) => {
            const line = doc.lineAt(f.from);
            return r.from <= line.to && r.to >= line.from;
          })
        : selection.ranges.some((r) => r.from <= f.to && r.to >= f.from);
      if (touched) continue; // show the raw marker for editing.
    }
    const widget = f.def ? new FootnoteDefWidget(f.label, f.num) : new FootnoteRefWidget(f);
    builder.add(f.from, f.to, Decoration.replace({ widget }));
  }
  return builder.finish();
}

/** Route a click on a defined reference to its definition. */
const footnoteClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null;
    const el = target?.closest?.('.cm-footnote-ref') as HTMLElement | null;
    if (el && !el.hasAttribute('role')) return true; // nothing in the body to jump to
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
            update.focusChanged ||
            update.startState.field(frontmatterField, false) !==
              update.state.field(frontmatterField, false)
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
  '.cm-footnote-ref.cm-footnote-source': {
    cursor: 'default',
  },
  '.cm-footnote-ref.cm-footnote-source:hover': {
    textDecoration: 'none',
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
