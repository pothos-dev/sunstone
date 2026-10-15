// Unit tests for the pure markdown formatting transforms (Ctrl+B / Ctrl+I / …).
// Run with `bun test src/lib`. Pins the toggle behaviour: wrapping, unwrapping
// (markers outside vs inside the selection), the empty-selection cursor park,
// and heading set / toggle-off across single and multi-line selections.
import { describe, expect, test } from 'bun:test';
import {
  headingFormatEdit,
  headingLevelAt,
  insertLink,
  linkAt,
  setHeadingLevel,
  toggleInlineWrap,
} from './textFormat';
import type { FormatChange } from './textFormat';

/** Apply a set of (non-overlapping) changes to a string, right-to-left. */
function applyChanges(doc: string, changes: FormatChange[]): string {
  const sorted = [...changes].sort((a, b) => b.from - a.from);
  let out = doc;
  for (const c of sorted) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

describe('toggleInlineWrap', () => {
  test('wraps a non-empty selection and selects the inner text', () => {
    // "foo bar" — select "bar" (4..7), bold it.
    expect(toggleInlineWrap('foo bar', 4, 7, '**')).toEqual({
      changes: [
        { from: 4, to: 4, insert: '**' },
        { from: 7, to: 7, insert: '**' },
      ],
      selection: { anchor: 6, head: 9 },
    });
  });

  test('unwraps when the markers sit outside the selection (inner text selected)', () => {
    // "**bar**" — select the inner "bar" (2..5).
    expect(toggleInlineWrap('**bar**', 2, 5, '**')).toEqual({
      changes: [
        { from: 0, to: 2, insert: '' },
        { from: 5, to: 7, insert: '' },
      ],
      selection: { anchor: 0, head: 3 },
    });
  });

  test('unwraps when the markers are included in the selection (whole run selected)', () => {
    // "**bar**" — select the whole thing (0..7).
    expect(toggleInlineWrap('**bar**', 0, 7, '**')).toEqual({
      changes: [
        { from: 0, to: 2, insert: '' },
        { from: 5, to: 7, insert: '' },
      ],
      selection: { anchor: 0, head: 3 },
    });
  });

  test('empty selection inserts an empty pair and parks the cursor between', () => {
    expect(toggleInlineWrap('foo', 1, 1, '*')).toEqual({
      changes: [{ from: 1, to: 1, insert: '**' }],
      selection: { anchor: 2, head: 2 },
    });
  });

  test('single-char markers (inline code) work the same way', () => {
    expect(toggleInlineWrap('a b', 2, 3, '`')).toEqual({
      changes: [
        { from: 2, to: 2, insert: '`' },
        { from: 3, to: 3, insert: '`' },
      ],
      selection: { anchor: 3, head: 4 },
    });
  });

  test('strikethrough uses the ~~ marker', () => {
    expect(toggleInlineWrap('done', 0, 4, '~~')).toEqual({
      changes: [
        { from: 0, to: 0, insert: '~~' },
        { from: 4, to: 4, insert: '~~' },
      ],
      selection: { anchor: 2, head: 6 },
    });
  });
});

describe('insertLink', () => {
  test('wraps a non-empty selection and parks the caret inside the empty parens', () => {
    // "foo bar" — select "bar" (4..7).
    const edit = insertLink('foo bar', 4, 7);
    expect(edit).toEqual({
      changes: [
        { from: 4, to: 4, insert: '[' },
        { from: 7, to: 7, insert: ']()' },
      ],
      selection: { anchor: 10, head: 10 },
    });
    // Applying the changes yields `foo [bar]()` and the caret sits between ( and ).
    const result = applyChanges('foo bar', edit.changes);
    expect(result).toBe('foo [bar]()');
    expect(result[edit.selection!.anchor - 1]).toBe('(');
    expect(result[edit.selection!.anchor]).toBe(')');
  });

  test('empty selection inserts a scaffold and parks the caret inside the brackets', () => {
    // "foo" — caret at 1.
    const edit = insertLink('foo', 1, 1);
    expect(edit).toEqual({
      changes: [{ from: 1, to: 1, insert: '[]()' }],
      selection: { anchor: 2, head: 2 },
    });
    const result = applyChanges('foo', edit.changes);
    expect(result).toBe('f[]()oo');
    // Caret is between [ and ]: [|]
    expect(result[edit.selection!.anchor - 1]).toBe('[');
    expect(result[edit.selection!.anchor]).toBe(']');
  });
});

describe('linkAt', () => {
  const doc = 'see [text](http://x) here';

  test('finds the link when pos is inside the url', () => {
    expect(linkAt(doc, 12)).toEqual({
      from: 4,
      to: 20,
      textFrom: 5,
      textTo: 9,
      urlFrom: 11,
      urlTo: 19,
    });
  });

  test('matches at both edges of the span (inclusive)', () => {
    expect(linkAt(doc, 4)?.from).toBe(4); // at the opening `[`
    expect(linkAt(doc, 20)?.from).toBe(4); // at the closing `)`
  });

  test('returns null just outside the span and when there is no link', () => {
    expect(linkAt(doc, 3)).toBeNull();
    expect(linkAt(doc, 25)).toBeNull();
    expect(linkAt('plain text, no links', 5)).toBeNull();
  });

  test('picks the link whose span contains pos among several on the line', () => {
    const multi = '[a](x) [b](y)';
    expect(linkAt(multi, 9)?.from).toBe(7); // inside the second link
    expect(linkAt(multi, 3)?.from).toBe(0); // inside the first link
  });

  test('handles an empty url with a zero-width url range', () => {
    // "[x]()" — url between ( and ) is empty.
    const at = linkAt('[x]()', 3);
    expect(at).toEqual({ from: 0, to: 5, textFrom: 1, textTo: 2, urlFrom: 4, urlTo: 4 });
  });
});

describe('setHeadingLevel', () => {
  test('adds a prefix to a plain line', () => {
    expect(setHeadingLevel('foo', 2)).toBe('## foo');
  });

  test('moves an existing heading to another level', () => {
    expect(setHeadingLevel('### bar', 1)).toBe('# bar');
  });

  test('level 0 strips the heading prefix', () => {
    expect(setHeadingLevel('## foo', 0)).toBe('foo');
    expect(setHeadingLevel('plain', 0)).toBe('plain');
  });
});

describe('headingFormatEdit', () => {
  test('sets a paragraph to a heading at the cursor line', () => {
    expect(headingFormatEdit('foo\nbar', 0, 0, 2)).toEqual({
      changes: [{ from: 0, to: 3, insert: '## foo' }],
    });
  });

  test('toggles off when the line is already exactly that level', () => {
    expect(headingFormatEdit('## foo', 0, 0, 2)).toEqual({
      changes: [{ from: 0, to: 6, insert: 'foo' }],
    });
  });

  test('applies to every non-blank line in a multi-line selection', () => {
    expect(headingFormatEdit('a\nb', 0, 3, 1)).toEqual({
      changes: [
        { from: 0, to: 1, insert: '# a' },
        { from: 2, to: 3, insert: '# b' },
      ],
    });
  });

  test('level 0 strips an existing heading', () => {
    expect(headingFormatEdit('# a', 0, 0, 0)).toEqual({
      changes: [{ from: 0, to: 3, insert: 'a' }],
    });
  });

  test('blank lines are left untouched', () => {
    // Selection spans "a", the blank line, then "b".
    expect(headingFormatEdit('a\n\nb', 0, 4, 1)).toEqual({
      changes: [
        { from: 0, to: 1, insert: '# a' },
        { from: 3, to: 4, insert: '# b' },
      ],
    });
  });
});

describe('headingLevelAt', () => {
  test('reads the caret line: its ATX level, or 0 for a paragraph', () => {
    expect(headingLevelAt('# One\nplain', 2, 2)).toBe(1);
    expect(headingLevelAt('# One\nplain', 8, 8)).toBe(0);
    expect(headingLevelAt('#nospace', 2, 2)).toBe(0); // not an ATX heading
  });

  test('a blank caret line reads as a paragraph', () => {
    expect(headingLevelAt('# One\n\n# Two', 6, 6)).toBe(0);
  });

  test('a selection reads the shared level of its non-blank lines, else null', () => {
    const doc = '## a\n\n## b\n### c';
    expect(headingLevelAt(doc, 0, 10)).toBe(2);
    expect(headingLevelAt(doc, 0, doc.length)).toBeNull();
  });
});
