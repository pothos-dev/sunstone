import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { findDiagramLanguage, type DiagramLanguage } from './diagramLanguage';
import { DIAGRAM_LANGUAGES } from './diagramLanguages';

// ---------------------------------------------------------------------------
// Diagram fence detection (dr-1, ADR-0005/0014)
//
// Pure, DOM-free detection of diagram fences in a CodeMirror document. Kept
// separate from the render/widget shell (diagram.ts) so it is unit-testable,
// following the `path.ts` / `outline.ts` convention.
//
// A Diagram (docs/GLOSSARY.md) is the rendered output of a `FencedCode` node
// whose info string names a registered diagram language (`diagramLanguages.ts`).
// This module finds those nodes and returns, for each, its language, the raw
// SOURCE (the fence body, between the open/close markers) and the DOCUMENT
// RANGE of the whole fence (so the render shell can `Decoration.replace` over
// it). All higher layers (lazy load, rendering, cursor-overlap reveal) build on
// these ranges.
// ---------------------------------------------------------------------------

/** A detected diagram fence: its language, its source and the doc range of the whole fence. */
export interface DiagramBlock {
  /** The registered language the fence's info string names. */
  readonly language: DiagramLanguage;
  /** The diagram source — the fence BODY, excluding the ``` markers/info line. */
  readonly source: string;
  /** Start offset of the whole fence (the opening ``` ) in the document. */
  readonly from: number;
  /** End offset of the whole fence (after the closing ``` ) in the document. */
  readonly to: number;
}

/**
 * Read the info string of a `FencedCode` node (the text after the opening
 * ``` on the first line). Returns the trimmed, lower-cased info, or '' when the
 * fence has no info. Reads the `CodeInfo` child when present; otherwise derives
 * it from the opening line so a fence parsed before its `CodeInfo` child exists
 * still classifies correctly.
 */
function fenceInfo(state: EditorState, fenceFrom: number, fenceTo: number): string {
  const tree = syntaxTree(state);
  const cursor = tree.cursorAt(fenceFrom, 1);
  // Walk into the FencedCode node's children to find CodeInfo.
  if (cursor.firstChild()) {
    do {
      if (cursor.name === 'CodeInfo') {
        return state.doc.sliceString(cursor.from, cursor.to).trim().toLowerCase();
      }
      if (cursor.from > fenceTo) break;
    } while (cursor.nextSibling());
  }
  // Fallback: parse the info off the opening line (after the ``` / ~~~ marker).
  const firstLine = state.doc.lineAt(fenceFrom).text;
  const match = firstLine.match(/^\s*(?:`{3,}|~{3,})\s*([^\s`]*)/);
  return (match?.[1] ?? '').trim().toLowerCase();
}

/**
 * Extract the diagram source (fence body) from a `FencedCode` node range: the
 * lines strictly between the opening fence line and the closing fence line.
 * Returns '' for an empty/unclosed fence body. Pure string slicing on the doc.
 */
function fenceBody(state: EditorState, fenceFrom: number, fenceTo: number): string {
  const startLine = state.doc.lineAt(fenceFrom);
  const endLine = state.doc.lineAt(fenceTo);
  // Body is the lines after the opening line up to (but not including) the
  // closing fence line. A single-line/unclosed fence has no body.
  const bodyFromLine = startLine.number + 1;
  // If the fence closes (its last line is a fence marker), drop that line;
  // otherwise (unclosed, EOF) the body runs to the last line.
  const lastLineText = endLine.text;
  const closes = /^\s*(?:`{3,}|~{3,})\s*$/.test(lastLineText);
  const bodyToLine = closes ? endLine.number - 1 : endLine.number;
  if (bodyToLine < bodyFromLine) return '';
  const from = state.doc.line(bodyFromLine).from;
  const to = state.doc.line(bodyToLine).to;
  return state.doc.sliceString(from, to);
}

/**
 * Find every diagram fence in the document — every `FencedCode` whose info
 * string names one of `languages` (default: the registry).
 *
 * Pushes the parser across the whole doc with a budget (like `imageBlocks`) so
 * fences past the initial budgeted parse window are still found — the render
 * shell additionally rebuilds on `treeGrowthEffect` for very long documents.
 *
 * @param state      the editor state to scan.
 * @param languages  the languages to detect (default `DIAGRAM_LANGUAGES`).
 * @param parseMs    budget for `ensureSyntaxTree` (default 200ms, matching
 *                   atomic-editor's block builders); 0 in tests to use the
 *                   already-parsed tree synchronously.
 */
export function findDiagramBlocks(
  state: EditorState,
  languages: readonly DiagramLanguage[] = DIAGRAM_LANGUAGES,
  parseMs = 200,
): DiagramBlock[] {
  const tree =
    (parseMs > 0 ? ensureSyntaxTree(state, state.doc.length, parseMs) : null) ??
    syntaxTree(state);
  const blocks: DiagramBlock[] = [];
  tree.iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return;
      const language = findDiagramLanguage(languages, fenceInfo(state, node.from, node.to));
      if (!language) return;
      blocks.push({
        language,
        source: fenceBody(state, node.from, node.to),
        from: node.from,
        to: node.to,
      });
    },
  });
  return blocks;
}

/**
 * True when the selection (any range) overlaps `[from, to]`. Used by the render
 * shell to decide whether to LIFT a diagram's block-replace and reveal the raw
 * fence for editing (hybrid). A cursor sitting exactly at either edge counts as
 * inside, so arrowing into the fence reveals it.
 */
export function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}
