import { EditorView, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import { StateField, type EditorState, type Extension } from '@codemirror/state';
import type { Source } from '$lib/wasm/exports';
import { scanFootnotes, sourceList } from '$lib/wasm/exports';
import { frontmatterField } from './frontmatter-field';
import { jumpAndFlash, jumpFlashField } from './jumpFlash';
import { attachSourceCard, detachSourceCard, usageText } from '$lib/sourceCard';
import { actorElement } from '$lib/actor';

// ---------------------------------------------------------------------------
// Sources section (ov-17, ov-10)
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
// Each entry also shows its credibility signals as written (`author` as an
// actor, `last_modified`, `usage_count` over its `usage_window`; no score), the
// text of a body `[^id]: …` definition, a jump back to every claim citing it
// (`↑`, or `↑ a b c`), and an Edit action that opens the Frontmatter Region on
// the entry (`onEditSource`). The definition line itself is hidden
// (`hiddenSourceDefs`): in reading mode always, while editing unless the
// selection is on it.
//
// The list itself (order, numbers, resource kinds, citing places, windows) is
// the shared Rust `source_list` over wasm; this module only builds the DOM.
// The native render emits the same section (`sources_section_html`).
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
    readonly onEditSource: ((index: number) => void) | undefined,
  ) {
    super();
  }
  eq(other: SourcesWidget): boolean {
    return (
      JSON.stringify(other.list) === JSON.stringify(this.list) &&
      other.onEditSource === this.onEditSource
    );
  }
  toDOM(view: EditorView): HTMLElement {
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
      const head = document.createElement('span');
      head.className = 'cm-source-head';
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
      head.append(title);
      const onEdit = this.onEditSource;
      if (onEdit) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'cm-source-edit';
        edit.dataset.testid = 'source-edit';
        edit.textContent = 'Edit';
        edit.title = 'Edit this entry in the Frontmatter';
        edit.addEventListener('mousedown', (e) => {
          e.preventDefault();
          onEdit(s.index);
        });
        head.append(edit);
      }
      body.append(head);
      if (s.title != null && s.resource) {
        const res = document.createElement('span');
        res.className = 'cm-source-resource';
        res.textContent = s.resource;
        body.append(res);
      }
      const signals = signalsElement(s);
      if (signals) body.append(signals);
      if (s.note) {
        const note = document.createElement('span');
        note.className = 'cm-source-note';
        note.textContent = s.note;
        body.append(note);
      }
      if (s.refs.length > 0) body.append(backrefsElement(view, s.refs));
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

/** The credibility signals as written (§5.1), or `null` when there are none. */
function signalsElement(s: Source): HTMLElement | null {
  const rows: [string, string | Node][] = [];
  if (s.author) rows.push(['Author', actorElement(s.author)]);
  if (s.lastModified) rows.push(['Last modified', s.lastModified]);
  const usage = usageText(s);
  if (usage) rows.push(['Usage count', usage]);
  if (rows.length === 0) return null;
  const wrap = document.createElement('span');
  wrap.className = 'cm-source-signals';
  for (const [key, value] of rows) {
    const item = document.createElement('span');
    item.className = 'cm-source-signal';
    const k = document.createElement('span');
    k.className = 'cm-source-signal-key';
    k.textContent = key;
    item.append(k, ' ', value);
    wrap.append(item);
  }
  return wrap;
}

/** Jumps back to each citing claim: `↑` for one place, `↑ a b c` for several. */
function backrefsElement(view: EditorView, refs: number[]): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'cm-source-backrefs';
  if (refs.length > 1) wrap.append('↑ ');
  refs.forEach((pos, i) => {
    const k = i + 1;
    const a = document.createElement('a');
    a.className = 'cm-source-backref';
    a.setAttribute('role', 'link');
    a.title = `Jump to citation ${k}`;
    a.textContent = refs.length === 1 ? '↑' : k <= 26 ? String.fromCharCode(96 + k) : `${k}`;
    a.addEventListener('mousedown', (e) => {
      e.preventDefault();
      // The offset is from when the widget was built; clamp in case the
      // document has shrunk since.
      jumpAndFlash(view, Math.min(pos, view.state.doc.length));
    });
    if (i > 0) wrap.append(' ');
    wrap.append(a);
  });
  return wrap;
}

function build(
  state: EditorState,
  onLinkClick: (url: string) => void,
  onEditSource: ((index: number) => void) | undefined,
): DecorationSet {
  const list = stateSources(state);
  if (list.length === 0) return Decoration.none;
  const widget = new SourcesWidget(list, onLinkClick, onEditSource);
  return Decoration.set([
    Decoration.widget({ widget, block: true, side: 1 }).range(state.doc.length),
  ]);
}

/**
 * The Sources section extension; `onLinkClick` opens an entry's resource,
 * `onEditSource` (optional) opens the Frontmatter on the entry at a list index.
 */
export function sourcesSection(
  onLinkClick: (url: string) => void,
  onEditSource?: (index: number) => void,
): Extension {
  return [
    StateField.define<DecorationSet>({
      create: (state) => build(state, onLinkClick, onEditSource),
      update(deco, tr) {
        const fmChanged =
          tr.startState.field(frontmatterField, false) !== tr.state.field(frontmatterField, false);
        return tr.docChanged || fmChanged ? build(tr.state, onLinkClick, onEditSource) : deco;
      },
      provide: (f) => EditorView.decorations.from(f),
    }),
    jumpFlashField,
  ];
}

/**
 * The lines of body `[^id]: …` definitions whose label is a `sources` id, as
 * `[from, to]` line ranges: their text shows on the Sources entry instead.
 */
export function sourceDefLines(state: EditorState): [number, number][] {
  const ids = [...sourcesById(stateSources(state)).keys()];
  if (ids.length === 0) return [];
  const doc = state.doc;
  const idSet = new Set(ids);
  const out: [number, number][] = [];
  for (const f of scanFootnotes(doc.toString(), ids)) {
    if (!f.def || !idSet.has(f.label.toLowerCase())) continue;
    const line = doc.lineAt(f.from);
    out.push([line.from, line.to]);
  }
  return out;
}

function buildHidden(state: EditorState, reading: boolean): DecorationSet {
  const ranges = sourceDefLines(state).filter(
    ([from, to]) => reading || !state.selection.ranges.some((r) => r.from <= to && r.to >= from),
  );
  return Decoration.set(
    ranges.map(([from, to]) => Decoration.replace({ block: true }).range(from, to)),
  );
}

/**
 * Hide body definitions for `sources` ids: always when `reading`; while
 * editing unless the selection touches the line, which then shows raw so it
 * can be edited or removed.
 */
export function hiddenSourceDefs(reading: boolean): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => buildHidden(state, reading),
    update(deco, tr) {
      const fmChanged =
        tr.startState.field(frontmatterField, false) !== tr.state.field(frontmatterField, false);
      return tr.docChanged || tr.selection || fmChanged ? buildHidden(tr.state, reading) : deco;
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
  '.cm-source-head': {
    display: 'flex',
    alignItems: 'baseline',
    gap: '0.6em',
  },
  'a.cm-source-title': {
    color: 'var(--atomic-editor-link)',
    cursor: 'pointer',
  },
  'a.cm-source-title:hover': {
    textDecoration: 'underline',
  },
  '.cm-source-edit': {
    font: 'inherit',
    fontSize: '0.8em',
    color: 'var(--text-muted)',
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: '0.25rem',
    padding: '0 0.35em',
    cursor: 'pointer',
    opacity: '0',
  },
  '.cm-sources-list li:hover .cm-source-edit, .cm-source-edit:focus-visible': {
    opacity: '1',
  },
  '.cm-source-resource': {
    color: 'var(--text-muted)',
    fontSize: '0.85em',
    overflowWrap: 'anywhere',
  },
  '.cm-source-signals': {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.2em 1em',
    fontSize: '0.85em',
  },
  '.cm-source-signal-key': {
    color: 'var(--text-muted)',
  },
  '.cm-source-note': {
    fontSize: '0.9em',
  },
  '.cm-source-backrefs': {
    fontSize: '0.85em',
    color: 'var(--text-muted)',
  },
  'a.cm-source-backref': {
    color: 'var(--accent)',
    cursor: 'pointer',
  },
  'a.cm-source-backref:hover': {
    textDecoration: 'underline',
  },
});
