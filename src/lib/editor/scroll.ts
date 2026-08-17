import { EditorView } from '@codemirror/view';

import { programmatic } from './extensions';

/**
 * The 1-based editor line sitting `offsetPx` below the top of the scroll
 * viewport — the probe the Outline's active-heading highlight rides on
 * (outline-active-heading). Returns null when the geometry is not measurable
 * yet (view not laid out / detached).
 */
export function lineAtViewportTop(view: EditorView, offsetPx: number): number | null {
  const rect = view.scrollDOM.getBoundingClientRect();
  if (rect.height === 0) return null;
  // Probe a little in from the left edge so the gutter never swallows the hit,
  // and clamp the y into the viewport so a short document still answers.
  const y = Math.min(rect.top + offsetPx, rect.bottom - 1);
  const pos = view.posAtCoords({ x: rect.left + 8, y }, false);
  return view.state.doc.lineAt(pos).number;
}

/**
 * Scroll the editor to (and place the cursor at the start of) `line`, a 1-based
 * line number. Used by full-text search to reveal the matching line after
 * opening a Concept. Clamps out-of-range lines (the doc may differ slightly
 * from the searched snapshot). Marked programmatic so the selection change is
 * not mistaken for a user edit.
 */
export function scrollToLine(
  view: EditorView,
  line: number,
  y: 'center' | 'start' = 'center',
): void {
  const total = view.state.doc.lines;
  const clamped = Math.max(1, Math.min(line, total));
  const pos = view.state.doc.line(clamped).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y }),
    annotations: programmatic.of(true),
  });
}
