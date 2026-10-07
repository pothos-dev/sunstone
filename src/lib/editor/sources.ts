import { EditorView, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import { StateField, type EditorState, type Extension } from '@codemirror/state';
import type { Source } from '$lib/wasm/exports';
import { sourceList } from '$lib/wasm/exports';
import { frontmatterField } from './frontmatter-field';
import { attachSourceCard, detachSourceCard } from '$lib/sourceCard';

// ---------------------------------------------------------------------------
// Sources section (ov-17)
//
// The Concept's `sources` Frontmatter list rendered as a bibliography at the
// end of the body: a block widget after the last line, so it is never part of
// the document and never written to the file. Each entry carries its footnote
// number (blank when the body does not cite it), its title linking to the
// resource, and the resource below; hover shows the entry's card
// (`sourceCard.ts`). A click opens the resource the way a rendered link does
// (`onLinkClick`: a Concept in the app, a URL in the browser); a scope
// descriptor is plain text.
//
// The list itself (order, numbers, resource kinds) is the shared
// Rust `source_list` over wasm; this module only builds the DOM. The native
// render emits the same section (`sources_section_html`).
// ---------------------------------------------------------------------------

/** The Concept's Sources section entries for `state`. */
export function stateSources(state: EditorState): Source[] {
  return sourceList(state.doc.toString(), state.field(frontmatterField, false) ?? '');
}

/** `sources` entries by lowercase id; the first entry with an id owns it. */
export function sourcesById(list: Source[]): Map<string, Source> {
  const byId = new Map<string, Source>();
  for (const s of list) {
    const id = s.id?.toLowerCase();
    if (id && !byId.has(id)) byId.set(id, s);
  }
  return byId;
}

class SourcesWidget extends WidgetType {
  constructor(
    readonly list: Source[],
    readonly onLinkClick: (url: string) => void,
  ) {
    super();
  }
  eq(other: SourcesWidget): boolean {
    return JSON.stringify(other.list) === JSON.stringify(this.list);
  }
  toDOM(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'cm-sources';
    section.dataset.testid = 'sources-section';
    const heading = document.createElement('div');
    heading.className = 'cm-sources-heading';
    heading.textContent = 'Sources';
    const ol = document.createElement('ol');
    ol.className = 'cm-sources-list';
    for (const s of this.list) {
      const li = document.createElement('li');
      const num = document.createElement('span');
      num.className = 'cm-source-num';
      num.textContent = s.num == null ? '' : `${s.num}`;
      const body = document.createElement('span');
      body.className = 'cm-source-body';
      const title = document.createElement(s.kind === 'descriptor' ? 'span' : 'a');
      title.className = 'cm-source-title';
      title.textContent = s.title ?? s.resource;
      attachSourceCard(title, s);
      if (s.kind !== 'descriptor') {
        title.setAttribute('role', 'link');
        title.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.onLinkClick(s.resource);
        });
      }
      body.append(title);
      if (s.title != null && s.resource) {
        const res = document.createElement('span');
        res.className = 'cm-source-resource';
        res.textContent = s.resource;
        body.append(res);
      }
      li.append(num, body);
      ol.append(li);
    }
    section.append(heading, ol);
    return section;
  }
  destroy(dom: HTMLElement): void {
    detachSourceCard(dom);
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function build(state: EditorState, onLinkClick: (url: string) => void): DecorationSet {
  const list = stateSources(state);
  if (list.length === 0) return Decoration.none;
  const widget = new SourcesWidget(list, onLinkClick);
  return Decoration.set([
    Decoration.widget({ widget, block: true, side: 1 }).range(state.doc.length),
  ]);
}

/** The Sources section extension; `onLinkClick` opens an entry's resource. */
export function sourcesSection(onLinkClick: (url: string) => void): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => build(state, onLinkClick),
    update(deco, tr) {
      const fmChanged =
        tr.startState.field(frontmatterField, false) !== tr.state.field(frontmatterField, false);
      return tr.docChanged || fmChanged ? build(tr.state, onLinkClick) : deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

/** Sources section styling (static, like `footnoteTheme`). */
export const sourcesTheme = EditorView.theme({
  '.cm-sources': {
    marginTop: '2.5em',
    paddingTop: '0.8em',
    borderTop: '1px solid var(--border)',
    fontSize: '0.9em',
    cursor: 'default',
  },
  '.cm-sources-heading': {
    fontWeight: '600',
    marginBottom: '0.5em',
  },
  '.cm-sources-list': {
    listStyle: 'none',
    margin: '0',
    padding: '0',
  },
  '.cm-sources-list li': {
    display: 'flex',
    gap: '0.6em',
    margin: '0.35em 0',
  },
  '.cm-source-num': {
    flex: '0 0 1.6em',
    textAlign: 'right',
    color: 'var(--accent)',
    fontWeight: '600',
  },
  '.cm-source-body': {
    display: 'flex',
    flexDirection: 'column',
    minWidth: '0',
  },
  'a.cm-source-title': {
    color: 'var(--atomic-editor-link)',
    cursor: 'pointer',
  },
  'a.cm-source-title:hover': {
    textDecoration: 'underline',
  },
  '.cm-source-resource': {
    color: 'var(--text-muted)',
    fontSize: '0.85em',
    overflowWrap: 'anywhere',
  },
});
