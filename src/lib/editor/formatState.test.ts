// Unit tests for the Toolbar's active-state readout (aa-1). Parses each doc with
// the editor's own GFM language, so the readout is pinned against the same tree
// the live preview renders from. `|` marks the caret; `[`…`]` a selection.
import { describe, expect, test } from 'bun:test';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { formatStateAt, NO_FORMAT, sameFormatState, type FormatState } from './formatState';
import { headingFormatEdit, toggleInlineWrap } from './textFormat';

/** Read the formats at the marked caret/selection of `marked`. */
function stateOf(marked: string): FormatState {
  const caret = marked.indexOf('|');
  let doc: string;
  let from: number;
  let to: number;
  if (caret !== -1) {
    doc = marked.slice(0, caret) + marked.slice(caret + 1);
    from = to = caret;
  } else {
    from = marked.indexOf('[[');
    doc = marked.replace('[[', '');
    to = doc.indexOf(']]');
    doc = doc.replace(']]', '');
  }
  return formatStateAt(markdownLanguage.parser.parse(doc), doc, from, to);
}

/** The inline flags that are on, as a sorted list (terse assertions). */
function on(s: FormatState): string[] {
  return (['bold', 'italic', 'code', 'strike', 'link'] as const).filter((k) => s[k]);
}

describe('formatStateAt — inline formats at a caret', () => {
  test('plain text reads as nothing active', () => {
    expect(stateOf('plain te|xt here')).toEqual(NO_FORMAT);
  });

  test('a caret inside each run reads that run', () => {
    expect(on(stateOf('a **bo|ld** b'))).toEqual(['bold']);
    expect(on(stateOf('a *ita|lic* b'))).toEqual(['italic']);
    expect(on(stateOf('a _ita|lic_ b'))).toEqual(['italic']);
    expect(on(stateOf('a `co|de` b'))).toEqual(['code']);
    expect(on(stateOf('a ~~str|ike~~ b'))).toEqual(['strike']);
  });

  test('a caret just outside the markers is outside the run', () => {
    expect(on(stateOf('a |**bold** b'))).toEqual([]);
    expect(on(stateOf('a **bold**| b'))).toEqual([]);
  });

  test('nested runs read all of their formats', () => {
    expect(on(stateOf('***bo|th***'))).toEqual(['bold', 'italic']);
    expect(on(stateOf('**bold ~~and st|rike~~**'))).toEqual(['bold', 'strike']);
  });

  test('markers inside inline code are not formatting', () => {
    expect(on(stateOf('`x **y|y** z`'))).toEqual(['code']);
  });

  test('escaped markers are not formatting', () => {
    expect(on(stateOf('\\*not ita|lic\\*'))).toEqual([]);
  });

  test('an empty pair, as the toggle leaves it on an empty selection, is not active', () => {
    // `toggleInlineWrap` on a caret inserts `****` and parks the caret between.
    expect(on(stateOf('a **|** b'))).toEqual([]);
  });

  test('a caret in an inline link reads link (the link control would edit it)', () => {
    expect(on(stateOf('see [the do|cs](./docs.md) now'))).toEqual(['link']);
    expect(on(stateOf('see [the docs](./do|cs.md) now'))).toEqual(['link']);
    expect(on(stateOf('see| [the docs](./docs.md) now'))).toEqual([]);
  });
});

describe('formatStateAt — inline formats over a selection', () => {
  test('selecting the inner text of a run reads it', () => {
    expect(on(stateOf('a **[[bold]]** b'))).toEqual(['bold']);
  });

  test('selecting the whole marked run reads it', () => {
    expect(on(stateOf('a [[**bold**]] b'))).toEqual(['bold']);
  });

  test('a selection running out of the run does not read it', () => {
    expect(on(stateOf('a **bo[[ld** b]]'))).toEqual([]);
    expect(on(stateOf('[[a **bold**]] b'))).toEqual([]);
  });

  test('the readout agrees with the toggle: what reads active, the toggle removes', () => {
    // After bolding "bar" the toggle selects the inner text; it must read bold,
    // and re-applying the toggle there must unwrap it.
    const doc = 'foo bar';
    const edit = toggleInlineWrap(doc, 4, 7, '**');
    const bolded = 'foo **bar**';
    const { anchor, head } = edit.selection!;
    expect(formatStateAt(markdownLanguage.parser.parse(bolded), bolded, anchor, head).bold).toBe(true);
    const undo = toggleInlineWrap(bolded, anchor, head, '**');
    expect(undo.changes.every((c) => c.insert === '')).toBe(true);
  });
});

describe('formatStateAt — heading level', () => {
  test('reads the ATX level of the caret line, 0 for a paragraph', () => {
    expect(stateOf('# Ti|tle\n\nbody').heading).toBe(1);
    expect(stateOf('###### De|ep').heading).toBe(6);
    expect(stateOf('# Title\n\nbo|dy').heading).toBe(0);
  });

  test('a multi-line selection reads a level only when every line shares it', () => {
    expect(stateOf('## [[a\n## b]]').heading).toBe(2);
    expect(stateOf('## [[a\n### b]]').heading).toBeNull();
    expect(stateOf('## [[a\n\n## b]]').heading).toBe(2); // blank lines are skipped
  });

  test('the readout agrees with the heading toggle', () => {
    // Re-applying the level read off a heading line strips it (the toggle).
    const doc = '## Title';
    expect(headingFormatEdit(doc, 3, 3, stateOf('## Ti|tle').heading!).changes).toEqual([
      { from: 0, to: 8, insert: 'Title' },
    ]);
  });
});

describe('sameFormatState', () => {
  test('compares every flag', () => {
    expect(sameFormatState(NO_FORMAT, { ...NO_FORMAT })).toBe(true);
    expect(sameFormatState(NO_FORMAT, { ...NO_FORMAT, bold: true })).toBe(false);
    expect(sameFormatState(NO_FORMAT, { ...NO_FORMAT, heading: null })).toBe(false);
  });
});
