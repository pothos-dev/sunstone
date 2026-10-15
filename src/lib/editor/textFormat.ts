// Markdown formatting transforms for the editor toolbar / keymap (Ctrl+B, …).
//
// Pure, CodeMirror-free logic so it can be unit-tested over plain strings (the
// project convention: pure `.ts`, thin CM wiring in `cm.ts`). Each function
// takes the document text plus a selection range and returns the CHANGES to
// apply (and, for inline wraps, the resulting selection) — the CM command
// layer in `cm.ts` just dispatches them.
//
// Everything toggles: re-applying a format that is already present removes it,
// matching the Obsidian behaviour users expect (ADR-0001 parity).

/** A change span the editor should apply: replace `[from, to)` with `insert`. */
export interface FormatChange {
  from: number;
  to: number;
  insert: string;
}

/** The result of a formatting transform: changes plus an optional new selection. */
export interface FormatEdit {
  changes: FormatChange[];
  /** The single selection range to set afterwards; omitted = let the editor remap. */
  selection?: { anchor: number; head: number };
}

/**
 * Toggle an inline wrap (`**`, `*`, `` ` ``, `~~`) around the selection.
 *
 * Already-wrapped selections are unwrapped — whether the markers sit just
 * OUTSIDE the selection (the common case: the inner text is selected) or are
 * INCLUDED in it (the whole `**bold**` is selected). An empty selection inserts
 * an empty pair and parks the cursor between the markers, so typing continues
 * the formatted run; pressing the shortcut again on that empty pair removes it.
 */
export function toggleInlineWrap(
  doc: string,
  from: number,
  to: number,
  marker: string,
): FormatEdit {
  const m = marker.length;

  // Markers immediately surrounding the selection (inner text selected).
  const outsideWrapped =
    from - m >= 0 && doc.slice(from - m, from) === marker && doc.slice(to, to + m) === marker;
  // Markers included at both ends of the selection (whole run selected).
  const insideWrapped =
    to - from >= 2 * m && doc.slice(from, from + m) === marker && doc.slice(to - m, to) === marker;

  if (outsideWrapped) {
    return {
      changes: [
        { from: from - m, to: from, insert: '' },
        { from: to, to: to + m, insert: '' },
      ],
      selection: { anchor: from - m, head: to - m },
    };
  }
  if (insideWrapped) {
    return {
      changes: [
        { from, to: from + m, insert: '' },
        { from: to - m, to, insert: '' },
      ],
      selection: { anchor: from, head: to - 2 * m },
    };
  }
  if (from === to) {
    return {
      changes: [{ from, to, insert: marker + marker }],
      selection: { anchor: from + m, head: from + m },
    };
  }
  return {
    changes: [
      { from, to: from, insert: marker },
      { from: to, to, insert: marker },
    ],
    selection: { anchor: from + m, head: to + m },
  };
}

/**
 * Wrap the selection as a markdown inline link `[text](url)`, parking the caret
 * where the user's next keystroke belongs.
 *
 *  - Non-empty selection → `[<sel>]()` with the caret between the empty parens,
 *    so the user types the URL for the text they highlighted.
 *  - Empty selection → `[]()` scaffolding with the caret between the brackets
 *    (`[|]()`), so the user types the link text first.
 *
 * `doc` is unused (the transform never inspects surrounding text) but kept for
 * signature parity with the other transforms. Follows the two-insert style of
 * `toggleInlineWrap` for the non-empty case so CodeMirror maps cleanly.
 */
export function insertLink(_doc: string, from: number, to: number): FormatEdit {
  if (from === to) {
    // `[]()` — caret between the brackets: [|]()
    return {
      changes: [{ from, to, insert: '[]()' }],
      selection: { anchor: from + 1, head: from + 1 },
    };
  }
  // `[` + <sel> + `]()`. After both inserts the layout is:
  //   [   sel   ]   (   )
  //   ^from      ^to+1    caret between ( and ) = to + 3
  return {
    changes: [
      { from, to: from, insert: '[' },
      { from: to, to, insert: ']()' },
    ],
    selection: { anchor: to + 3, head: to + 3 },
  };
}

/**
 * Detect a markdown inline link `[text](url)` whose full span contains `pos`
 * (inclusive of both edges). Returns the delimiter-EXCLUSIVE ranges — the text
 * between `[` and `]`, and the url between `(` and `)` — plus the full `[from,
 * to)` span. Returns `null` when `pos` sits in no link. When several links share
 * the line, the first whose span contains `pos` wins. An empty url (`[x]()`)
 * yields a zero-width url range (`urlFrom === urlTo`).
 *
 * Pure regex scan (no Lezer) so it is unit-testable over plain strings.
 */
export function linkAt(
  doc: string,
  pos: number,
): { from: number; to: number; textFrom: number; textTo: number; urlFrom: number; urlTo: number } | null {
  const re = /\[([^\]]*)\]\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    const from = m.index;
    const to = from + m[0].length;
    if (pos < from || pos > to) continue;
    const textFrom = from + 1;
    const textTo = textFrom + m[1].length;
    const urlFrom = textTo + 2; // skip the `](`
    const urlTo = urlFrom + m[2].length;
    return { from, to, textFrom, textTo, urlFrom, urlTo };
  }
  return null;
}

/** The ATX heading level of a line (1–6), or 0 when it is not a heading. */
function headingLevel(line: string): number {
  const m = /^(#{1,6})[ \t]+/.exec(line);
  return m ? m[1].length : 0;
}

/**
 * Return `line` rendered at heading `level` (1–6), or as a plain paragraph when
 * `level <= 0`. Any existing `#` prefix is stripped first, so the transform is
 * idempotent and can move a line between levels.
 */
export function setHeadingLevel(line: string, level: number): string {
  const m = /^(#{1,6})[ \t]+/.exec(line);
  const rest = m ? line.slice(m[0].length) : line;
  if (level <= 0) return rest;
  return '#'.repeat(level) + ' ' + rest;
}

/** The `[start, end)` offsets of every line overlapping `[from, to]`. */
function lineSpans(doc: string, from: number, to: number): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let pos = doc.lastIndexOf('\n', from - 1) + 1;
  for (;;) {
    const nl = doc.indexOf('\n', pos);
    const end = nl === -1 ? doc.length : nl;
    spans.push({ start: pos, end });
    if (nl === -1 || nl >= to) break;
    pos = nl + 1;
  }
  return spans;
}

/**
 * Toggle ATX heading level `level` (1–6, or 0 for "plain paragraph") across
 * every non-blank line the selection touches.
 *
 * Toggle semantics: when EVERY non-blank target line is already exactly `level`,
 * the heading is removed (level → paragraph); otherwise all target lines are set
 * to `level`. Blank lines are left untouched so a heading shortcut over a
 * paragraph-with-trailing-newline never produces a stray `# ` line. `level <= 0`
 * always strips to a paragraph.
 */
export function headingFormatEdit(
  doc: string,
  from: number,
  to: number,
  level: number,
): FormatEdit {
  const spans = lineSpans(doc, from, to);
  const texts = spans.map((s) => doc.slice(s.start, s.end));
  const targets = texts.filter((t) => t.trim().length > 0);

  const target =
    level > 0 && targets.length > 0 && targets.every((t) => headingLevel(t) === level)
      ? 0
      : level;

  const changes: FormatChange[] = [];
  for (let i = 0; i < spans.length; i++) {
    const text = texts[i];
    if (text.trim().length === 0) continue; // never format a blank line
    const next = setHeadingLevel(text, target);
    if (next !== text) changes.push({ from: spans[i].start, to: spans[i].end, insert: next });
  }
  return { changes };
}

/**
 * The heading level the selection reads as — the readout half of
 * `headingFormatEdit`, over the same lines it would format:
 *   - `1`–`6` when every non-blank line the selection touches is that ATX level,
 *   - `0` when they are all plain paragraphs (or every touched line is blank),
 *   - `null` when the lines disagree (a mixed selection).
 * Applying `headingFormatEdit` with a level other than the one returned here
 * sets it; applying the returned level removes it (the toggle).
 */
export function headingLevelAt(doc: string, from: number, to: number): number | null {
  const levels = lineSpans(doc, from, to)
    .map((s) => doc.slice(s.start, s.end))
    .filter((t) => t.trim().length > 0)
    .map(headingLevel);
  if (levels.length === 0) return 0;
  return levels.every((l) => l === levels[0]) ? levels[0] : null;
}
