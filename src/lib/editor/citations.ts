import {
  EditorView,
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { findCitationRefs, citationDefPos } from '$lib/wasm/exports';
import { jumpFlashField, jumpAndFlash } from './jumpFlash';

// ---------------------------------------------------------------------------
// Citation references (slice: citation-superscripts)
//
// Inline `[n]` tokens that follow a word — `…and body.[6][7][8]` — render as
// SUPERSCRIPT, clickable links. A click scrolls to the matching row of the
// citation table lower in the same Concept (`[n] …` at line start) and briefly
// flashes it. The pure `findCitationRefs` / `citationDefPos` helpers decide what
// is a reference and where its definition lives; this module is the thin
// CodeMirror layer (widget + click + flash).
//
// Why this is safe against atomic-editor: the GFM parser reads `[6][7]` as a
// URL-less reference link, and atomic deliberately leaves URL-less `[n]` as
// literal text (no replace decoration) — so our replace decoration is the only
// one over that span. It also OVERRIDES the stray `LinkLabel` syntax colour that
// made the middle number (`7`) look highlighted.
//
// Modes: wired into the mode-dependent slice (`modeExtensions`), so it is active
// in hybrid + reading and absent in `edit` (source) mode, where raw `[6]` shows.
// In hybrid the raw token is revealed when the cursor sits on it (for editing);
// in reading mode it always renders.
// ---------------------------------------------------------------------------

/** Superscript link standing in for a `[n]` citation reference. */
class CitationWidget extends WidgetType {
  constructor(readonly num: string) {
    super();
  }
  eq(other: CitationWidget): boolean {
    return other.num === this.num;
  }
  toDOM(): HTMLElement {
    const sup = document.createElement('sup');
    sup.className = 'cm-citation-ref';
    sup.textContent = `[${this.num}]`;
    sup.dataset.citation = this.num;
    sup.setAttribute('role', 'link');
    sup.setAttribute('aria-label', `Citation ${this.num}`);
    sup.title = `Jump to citation ${this.num}`;
    return sup;
  }
  // Let clicks reach our DOM handler rather than being swallowed as an atom.
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Build the citation-reference decorations for the visible viewport. In hybrid
 * mode (`reading` false) a reference overlapped by the cursor is left raw so it
 * can be edited; in reading mode everything renders. Scans the whole document so
 * the "follows a word" test never loses context at a viewport slice boundary
 * (Concepts are small); only visible decorations are painted by CodeMirror.
 */
function computeCitations(view: EditorView, reading: boolean): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();
  const revealCursor = !reading && view.hasFocus;
  const sel = view.state.selection;
  for (const ref of findCitationRefs(text)) {
    if (
      revealCursor &&
      sel.ranges.some((r) => r.from <= ref.to && r.to >= ref.from)
    ) {
      continue; // cursor on the token → show raw `[n]` for editing.
    }
    builder.add(ref.from, ref.to, Decoration.replace({ widget: new CitationWidget(ref.num) }));
  }
  return builder.finish();
}

/**
 * Scroll to citation `num`'s definition row and flash it. No-op when the number
 * has no matching row (a dangling reference).
 */
function jumpToCitation(view: EditorView, num: string): void {
  const pos = citationDefPos(view.state.doc.toString(), num);
  if (pos != null) jumpAndFlash(view, pos);
}

/** Route a click on a superscript reference to `jumpToCitation`. */
const citationClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null;
    const el = target?.closest?.('.cm-citation-ref') as HTMLElement | null;
    const num = el?.dataset.citation;
    if (!num) return false;
    event.preventDefault();
    jumpToCitation(view, num);
    return true;
  },
});

/**
 * The citation extension for a given render mode. `reading` (view mode) renders
 * every reference unconditionally; hybrid reveals the one under the cursor.
 */
export function citations(reading: boolean): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = computeCitations(view, reading);
        }
        update(update: ViewUpdate) {
          if (
            update.docChanged ||
            update.viewportChanged ||
            update.selectionSet ||
            update.focusChanged
          ) {
            this.decorations = computeCitations(update.view, reading);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
    jumpFlashField,
    citationClick,
  ];
}

/** Superscript-link + jump-target styling (static; layered like `wikiLinkTheme`). */
export const citationTheme = EditorView.theme({
  '.cm-citation-ref': {
    color: 'var(--accent)',
    cursor: 'pointer',
    fontWeight: '600',
    // `<sup>` already raises + shrinks; nudge the size for legibility.
    fontSize: '0.72em',
    padding: '0 0.05em',
  },
  '.cm-citation-ref:hover': {
    textDecoration: 'underline',
  },
  '.cm-citation-target': {
    backgroundColor: 'var(--accent-soft)',
    transition: 'background-color 0.4s ease',
    borderRadius: '3px',
  },
});
