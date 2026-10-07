import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { Text as DocText, type Extension } from '@codemirror/state';
import { getSearchQuery, searchPanelOpen, type SearchQuery } from '@codemirror/search';

// Find highlighting inside table widgets.
//
// @codemirror/search paints its matches as mark decorations, and a mark cannot
// reach into atomic-editor's table widget — a block `replace` decoration whose
// cells are the widget's own DOM. So a match inside a table was found (and
// selected) but never visible. This plugin repeats the search over each rendered
// cell's text and paints the hits through the CSS Custom Highlight API, which
// styles DOM ranges without touching the (contenteditable) cell DOM. The colours
// are the `::highlight(...)` rules in `app.css`.

export const MATCH_HIGHLIGHT = 'sunstone-table-search';
export const SELECTED_HIGHLIGHT = 'sunstone-table-search-selected';

export interface TextSpan {
  from: number;
  to: number;
}

/** Every match of `query` in `text`, honouring its case / word / regexp flags. */
export function cellMatches(query: SearchQuery, text: string): TextSpan[] {
  if (!query.valid || !text) return [];
  const cursor = query.getCursor(DocText.of(text.split('\n')));
  const out: TextSpan[] = [];
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    out.push({ from: next.value.from, to: next.value.to });
  }
  return out;
}

/** A position inside a table, as the widget lays its cells out. */
export interface TableCellPos {
  /** Row in DOM order: 0 is the header, 1.. the body rows. */
  row: number;
  col: number;
  /** The cell's raw (trimmed) markdown. */
  raw: string;
  /** Offset of the position within `raw`. */
  offset: number;
}

/**
 * Locate column `column` of `line`, the `lineIndex`-th line of a table, as a
 * widget cell. Splits on unescaped `|` exactly like atomic-editor's
 * `splitRowCells`. Null on the delimiter row, a pipe, or the padding around a
 * cell's text.
 */
export function tableCellAt(line: string, lineIndex: number, column: number): TableCellPos | null {
  if (lineIndex === 1) return null;
  const row = lineIndex === 0 ? 0 : lineIndex - 1;
  // The span of the row's content between the optional outer pipes.
  let start = line.length - line.trimStart().length;
  let end = line.trimEnd().length;
  if (line[start] === '|') start++;
  if (end > start && line[end - 1] === '|') end--;
  if (column < start || column > end) return null;

  let col = 0;
  let cellStart = start;
  for (let i = start; i <= end; i++) {
    if (i + 1 < end && line[i] === '\\') {
      i++;
      continue;
    }
    if (i < end && line[i] !== '|') continue;
    // [cellStart, i) is one cell.
    if (column >= cellStart && column <= i) {
      const text = line.slice(cellStart, i);
      const lead = text.length - text.trimStart().length;
      const raw = text.trim();
      const offset = column - cellStart - lead;
      if (offset < 0 || offset > raw.length) return null;
      return { row, col, raw, offset };
    }
    col++;
    cellStart = i + 1;
  }
  return null;
}

/**
 * Which of a cell's matches is the editor's selected match: the selection
 * `[from, to)` must lie in cell `pos` and be exactly a match of `query` in the
 * cell's raw text. Returns that match's index among the cell's matches (so it
 * survives the widget rendering the text with escapes stripped), else -1.
 */
export function selectedMatchIndex(query: SearchQuery, pos: TableCellPos, length: number): number {
  return cellMatches(query, pos.raw).findIndex(
    (m) => m.from === pos.offset && m.to - m.from === length,
  );
}

/** DOM ranges covering `spans` of the text inside `root` (all text nodes, in order). */
function domRanges(root: Node, spans: TextSpan[]): Range[] {
  const nodes: { node: Text; start: number }[] = [];
  let length = 0;
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: length });
    length += (n as Text).data.length;
  }
  const locate = (offset: number, preferNext: boolean) => {
    for (let i = 0; i < nodes.length; i++) {
      const { node, start } = nodes[i];
      const end = start + node.data.length;
      if (offset < end || (offset === end && !preferNext) || i === nodes.length - 1) {
        return { node, offset: Math.min(offset - start, node.data.length) };
      }
    }
    return null;
  };
  const out: Range[] = [];
  for (const span of spans) {
    const a = locate(span.from, true);
    const b = locate(span.to, false);
    if (!a || !b) continue;
    const range = root.ownerDocument!.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    out.push(range);
  }
  return out;
}

// One registry entry per highlight name is shared by every editor on the page,
// so each view contributes its ranges here and `publish` rebuilds the union.
const contributions = new Map<object, { all: Range[]; selected: Range[] }>();

function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

function publish(): void {
  if (!highlightsSupported()) return;
  const all: Range[] = [];
  const selected: Range[] = [];
  for (const c of contributions.values()) {
    all.push(...c.all);
    selected.push(...c.selected);
  }
  const match = new Highlight(...all);
  const current = new Highlight(...selected);
  current.priority = 1;
  CSS.highlights.set(MATCH_HIGHLIGHT, match);
  CSS.highlights.set(SELECTED_HIGHLIGHT, current);
}

/** Collect the match ranges of the open find query across `view`'s table widgets. */
function collect(view: EditorView): { all: Range[]; selected: Range[] } {
  const all: Range[] = [];
  const selected: Range[] = [];
  const { state } = view;
  if (!searchPanelOpen(state)) return { all, selected };
  const query = getSearchQuery(state);
  if (!query.valid) return { all, selected };

  const main = state.selection.main;
  for (const wrap of view.contentDOM.querySelectorAll<HTMLElement>('.cm-atomic-table')) {
    const tableFrom = view.posAtDOM(wrap);
    if (tableFrom < 0) continue;
    // The selected match, if it sits in this table, as (row, col, index).
    let current: { row: number; col: number; index: number } | null = null;
    const rows = wrap.querySelectorAll('tr');
    const startLine = state.doc.lineAt(tableFrom);
    const lineIndex = state.doc.lineAt(main.from).number - startLine.number;
    // The table's lines: one per `tr`, plus the delimiter row.
    if (!main.empty && lineIndex >= 0 && lineIndex <= rows.length) {
      const line = state.doc.lineAt(main.from);
      const pos = tableCellAt(line.text, lineIndex, main.from - line.from);
      if (pos) {
        const index = selectedMatchIndex(query, pos, main.to - main.from);
        if (index >= 0) current = { row: pos.row, col: pos.col, index };
      }
    }
    rows.forEach((tr, row) => {
      tr.querySelectorAll('th, td').forEach((cell, col) => {
        const source = cell.querySelector('.cm-atomic-table-cell-source');
        if (!source) return;
        const ranges = domRanges(source, cellMatches(query, source.textContent ?? ''));
        ranges.forEach((range, i) => {
          if (current && current.row === row && current.col === col && current.index === i) {
            selected.push(range);
          } else {
            all.push(range);
          }
        });
      });
    });
  }
  return { all, selected };
}

/** Paint the open find query's matches inside table widgets. */
export function tableSearchHighlight(): Extension {
  if (!highlightsSupported()) return [];
  return ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {
        this.refresh();
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          getSearchQuery(update.state) !== getSearchQuery(update.startState) ||
          searchPanelOpen(update.state) !== searchPanelOpen(update.startState)
        ) {
          this.refresh();
        }
      }

      destroy() {
        contributions.delete(this);
        publish();
      }

      private refresh() {
        // After the update's DOM write, so rebuilt widgets are in the document.
        this.view.requestMeasure({
          read: () => collect(this.view),
          write: (found) => {
            contributions.set(this, found);
            publish();
          },
        });
      }
    },
  );
}
