import { EditorView, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import { StateField, type EditorState, type Extension } from '@codemirror/state';
import { contractCardHtml } from '$lib/computation';
import { frontmatterField } from './frontmatter-field';

// ---------------------------------------------------------------------------
// Contract card (ov-12)
//
// An Attested Computation's contract (`runtime`, `parameters`, `computation`,
// `executor`, `attester`) shown above the body, after the trust line. A block
// widget before the first line, never part of the document; rebuilt from the
// Frontmatter on every change. The markup is `$lib/computation` (the same the
// native render emits). A path-valued field opens through `onLinkClick`, the
// way a rendered link does (a Concept in the app, a URL in the browser).
// Display only: nothing is run or verified.
// ---------------------------------------------------------------------------

class ContractWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly onLinkClick: (url: string) => void,
  ) {
    super();
  }
  eq(other: ContractWidget): boolean {
    return other.html === this.html && other.onLinkClick === this.onLinkClick;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-computation';
    // Built from escaped text only (`contractHtml`).
    wrap.innerHTML = this.html;
    wrap.addEventListener('mousedown', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('a[data-resource]');
      if (!a) return;
      e.preventDefault();
      this.onLinkClick(a.dataset.resource ?? '');
    });
    // The raw `href` is never followed: the click above resolves it.
    wrap.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a[data-resource]')) e.preventDefault();
    });
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function build(state: EditorState, onLinkClick: (url: string) => void): DecorationSet {
  const html = contractCardHtml(state.field(frontmatterField, false) ?? '');
  if (!html) return Decoration.none;
  // `side: 0` keeps it after the trust line (`side: -1`) at the same position.
  return Decoration.set([
    Decoration.widget({ widget: new ContractWidget(html, onLinkClick), block: true, side: 0 }).range(0),
  ]);
}

/** The contract card extension (hybrid and reading modes). */
export function contractCard(onLinkClick: (url: string) => void): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => build(state, onLinkClick),
    update(deco, tr) {
      const fmChanged =
        tr.startState.field(frontmatterField, false) !== tr.state.field(frontmatterField, false);
      if (fmChanged) return build(tr.state, onLinkClick);
      return tr.docChanged ? deco.map(tr.changes) : deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
