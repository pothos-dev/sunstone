// Active-state readout for the formatting Toolbar (aa-1): which formats apply
// at the selection, so a control can show as pressed when the caret sits in
// text that already carries its format.
//
// Pure over a Lezer markdown tree + the document text + a selection range, so
// it is unit-testable with `markdownLanguage.parser.parse(doc)` and needs no
// view. The CodeMirror adapter (`formatStateOf`) just feeds it the editor's
// `syntaxTree` and main selection. Reading the parse tree rather than scanning
// for markers means the readout agrees with what the live preview renders:
// `**` inside inline code is not bold, an escaped `\*` is not italic.

import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import { headingLevelAt, linkAt } from './textFormat';

/** The formats active at a selection, one flag per Toolbar control. */
export interface FormatState {
  bold: boolean;
  italic: boolean;
  code: boolean;
  strike: boolean;
  /**
   * The caret sits in an inline `[text](url)` link — exactly when the link
   * control would EDIT that link rather than insert a new one (`linkAt`, the
   * same test `insertOrEditLink` makes).
   */
  link: boolean;
  /** Heading level 1–6, 0 for a paragraph, `null` for a mixed selection. */
  heading: number | null;
}

/** Nothing active: a paragraph with no inline format. */
export const NO_FORMAT: FormatState = {
  bold: false,
  italic: false,
  code: false,
  strike: false,
  link: false,
  heading: 0,
};

/** Lezer (GFM) node name → the inline flag it sets. */
const INLINE_NODES: Record<string, 'bold' | 'italic' | 'code' | 'strike'> = {
  StrongEmphasis: 'bold',
  Emphasis: 'italic',
  InlineCode: 'code',
  Strikethrough: 'strike',
};

/**
 * Whether a node spanning `[nodeFrom, nodeTo)` holds the selection. A caret
 * counts only when strictly inside, so a caret just before the opening marker
 * or just after the closing one reads as outside the run (typing there does
 * not extend it). A range counts when the node covers all of it — both the
 * inner text and the whole marked run, the two cases `toggleInlineWrap`
 * unwraps.
 */
function holds(nodeFrom: number, nodeTo: number, from: number, to: number): boolean {
  if (from === to) return nodeFrom < from && from < nodeTo;
  return nodeFrom <= from && to <= nodeTo;
}

/**
 * The formats active over `[from, to]` of `doc`, read off `tree` (a markdown
 * parse of `doc`). Inline flags are set when a node of that kind holds the
 * whole selection; the heading level comes from `headingLevelAt`, the readout
 * twin of the heading toggle. `head` is the selection's moving end (default
 * `to`), where the link control looks for a link to edit.
 */
export function formatStateAt(
  tree: Tree,
  doc: string,
  from: number,
  to: number,
  head: number = to,
): FormatState {
  const state: FormatState = {
    ...NO_FORMAT,
    link: linkAt(doc, head) !== null,
    heading: headingLevelAt(doc, from, to),
  };
  tree.iterate({
    from,
    to,
    enter: (node) => {
      // A child can only hold the selection if its parent does: prune there.
      if (node.name !== 'Document' && !holds(node.from, node.to, from, to)) return false;
      const flag = INLINE_NODES[node.name];
      if (flag) state[flag] = true;
      return undefined;
    },
  });
  return state;
}

/** Whether two readouts are equal (lets the host skip no-op reactive writes). */
export function sameFormatState(a: FormatState, b: FormatState): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.code === b.code &&
    a.strike === b.strike &&
    a.link === b.link &&
    a.heading === b.heading
  );
}

/** The CodeMirror adapter: the readout at a state's main selection. */
export function formatStateOf(state: EditorState): FormatState {
  const { from, to, head } = state.selection.main;
  return formatStateAt(syntaxTree(state), state.doc.toString(), from, to, head);
}
