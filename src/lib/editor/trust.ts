import { EditorView, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import { StateField, type EditorState, type Extension } from '@codemirror/state';
import { trustLineHtml } from '$lib/trust';
import { frontmatterField } from './frontmatter-field';

// ---------------------------------------------------------------------------
// Trust line (ov-9)
//
// The Concept's `generated` / `verified` Frontmatter (or a legacy `timestamp`)
// shown as one line above the body: the derived trust tier, who generated it
// and when, who verified it and when. A block widget before the first line,
// so it is never part of the document and never written to the file. The
// markup is `$lib/trust` (the same the native render emits); it is rebuilt
// from the Frontmatter on every change, so the tier always follows `verified`
// and is never stored.
// ---------------------------------------------------------------------------

class TrustWidget extends WidgetType {
  constructor(readonly html: string) {
    super();
  }
  eq(other: TrustWidget): boolean {
    return other.html === this.html;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-trust';
    // Built from escaped text only (`trustHtml`).
    wrap.innerHTML = this.html;
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function build(state: EditorState): DecorationSet {
  const html = trustLineHtml(state.field(frontmatterField, false) ?? '');
  if (!html) return Decoration.none;
  return Decoration.set([
    Decoration.widget({ widget: new TrustWidget(html), block: true, side: -1 }).range(0),
  ]);
}

/** The trust line extension (hybrid and reading modes). */
export function trustLine(): Extension {
  return StateField.define<DecorationSet>({
    create: build,
    update(deco, tr) {
      const fmChanged =
        tr.startState.field(frontmatterField, false) !== tr.state.field(frontmatterField, false);
      if (fmChanged) return build(tr.state);
      return tr.docChanged ? deco.map(tr.changes) : deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
