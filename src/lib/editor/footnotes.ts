import {
  EditorView,
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import type { Footnote, Source } from '$lib/wasm/exports';
import { scanFootnotes, footnoteDefPos } from '$lib/wasm/exports';
import { frontmatterField } from './frontmatter-field';
import { jumpFlashField, jumpAndFlash } from './jumpFlash';
import { stateSources, sourcesById } from './sources';
import { attachSourceCard, detachSourceCard } from '$lib/sourceCard';

// ---------------------------------------------------------------------------
// Footnotes (ov-14)
//
// A `[^label]` reference renders as a superscript `n`, its label's number by
// first reference (`1,2` for adjacent ones). A label that matches a
// `sources[].id` in the Frontmatter cites that source (OKF v0.2 §5.1, no body
// definition needed): hover shows the entry's card at once (`sourceCard.ts`)
// and a click opens its
// resource directly, the way a rendered link opens (`onLinkClick`: a Concept
// in the app, a URL in the browser); a scope descriptor is not clickable
// (ov-17). Any other label shows itself on hover, and a click scrolls to its
// `[^label]:` definition and flashes that line, the same jump the `[n]`
// citations make (the shared `jumpFlash`). A label with neither renders as
// broken. A definition's `[^label]:` marker renders as an `n` row head.
//
// Recognition is the shared Rust `scan_footnotes` (over wasm); this module is
// the thin CodeMirror layer. Modes follow `citations.ts`: reading always
// renders; hybrid shows the raw reference under the cursor, and the raw
// definition marker while the cursor is on its line.
// ---------------------------------------------------------------------------

/** Superscript standing in for a `[^label]` reference. */
class FootnoteRefWidget extends WidgetType {
  constructor(
    readonly f: Footnote,
    readonly source: Source | undefined,
  ) {
    super();
  }
  eq(other: FootnoteRefWidget): boolean {
    const [a, b] = [this.f, other.f];
    const [s, t] = [this.source, other.source];
    return (
      a.label === b.label &&
      a.num === b.num &&
      a.defined === b.defined &&
      a.hasDef === b.hasDef &&
      a.followsRef === b.followsRef &&
      JSON.stringify(s) === JSON.stringify(t)
    );
  }
  toDOM(): HTMLElement {
    const { label, num, defined, hasDef, followsRef } = this.f;
    const sup = document.createElement('sup');
    sup.className = defined ? 'cm-footnote-ref' : 'cm-footnote-ref cm-footnote-broken';
    // `1,2` rather than `12` for adjacent references.
    sup.textContent = followsRef ? `,${num}` : `${num}`;
    sup.dataset.footnote = label;
    const source = this.source;
    if (source) {
      sup.classList.add('cm-footnote-source');
      attachSourceCard(sup, source);
      if (source.kind !== 'descriptor') {
        sup.dataset.resource = source.resource;
        sup.setAttribute('role', 'link');
        sup.setAttribute('aria-label', `Source ${num}: ${source.title ?? source.resource}`);
      }
    } else if (hasDef) {
      sup.setAttribute('role', 'link');
      sup.setAttribute('aria-label', `Footnote ${num}: ${label}`);
      sup.title = label;
    } else if (defined) {
      sup.title = label;
    } else {
      sup.title = `${label}: no definition and no matching source`;
    }
    return sup;
  }
  destroy(dom: HTMLElement): void {
    detachSourceCard(dom);
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
  const sources = sourcesById(stateSources(view.state));
  for (const f of scanFootnotes(doc.toString(), [...sources.keys()])) {
    // A definition for a `sources` id is hidden whole, or shown raw while the
    // selection is on it (`hiddenSourceDefs`, ov-10): no row head either way.
    if (f.def && sources.has(f.label.toLowerCase())) continue;
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
      ? new FootnoteDefWidget(f.label, f.num)
      : new FootnoteRefWidget(f, sources.get(f.label.toLowerCase()));
    builder.add(f.from, f.to, Decoration.replace({ widget }));
  }
  return builder.finish();
}

/** Route a click on a reference to its source's resource or its definition. */
function footnoteClick(onLinkClick: (url: string) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement | null;
      const el = target?.closest?.('.cm-footnote-ref') as HTMLElement | null;
      if (!el) return false;
      if (!el.hasAttribute('role')) return true; // nothing to open or jump to
      event.preventDefault();
      if (el.dataset.resource != null) {
        onLinkClick(el.dataset.resource);
        return true;
      }
      const pos = footnoteDefPos(view.state.doc.toString(), el.dataset.footnote ?? '');
      if (pos != null) jumpAndFlash(view, pos);
      return true;
    },
  });
}

/**
 * The footnote extension for a render mode (see `citations`); `onLinkClick`
 * opens a cited source's resource.
 */
export function footnotes(reading: boolean, onLinkClick: (url: string) => void): Extension {
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
    footnoteClick(onLinkClick),
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
  '.cm-footnote-ref:not([role])': {
    cursor: 'default',
  },
  '.cm-footnote-ref:not([role]):hover': {
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
