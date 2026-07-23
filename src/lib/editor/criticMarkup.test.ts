// Unit tests for the TS CriticMarkup VIEW/AUTHORING half (ADR 0006 family 13):
// the pure decoration descriptors (`changeMarkDecorations`) and the authoring
// change sets (`insertHighlightComment` / `setCommentText` / `removeAnnotation`),
// each applied to a string to confirm the result. The PARSE half
// (`parseCriticMarks` / `pairAnnotations` / `annotationAt`) migrated to Rust
// (`sunstone_shared::critic`) — its goldens live in `cargo test`; here it is only
// used (via the wasm free-export holder, byte-loaded by `bunTestSetup`) to build
// the marks/annotations these TS helpers consume.
import { describe, expect, test } from 'bun:test';
import { parseCriticMarks, pairAnnotations, type Annotation } from '$lib/wasm/exports';
import {
  changeMarkDecorations,
  insertHighlightComment,
  removeAnnotation,
  setCommentText,
  type CriticDeco,
} from './criticMarkup';

/** Apply a change set to a doc string (test-only remap, mirrors CM's dispatch). */
function applyChanges(doc: string, changes: { from: number; to: number; insert: string }[]): string {
  const sorted = [...changes].sort((a, b) => a.from - b.from);
  let out = '';
  let pos = 0;
  for (const c of sorted) {
    out += doc.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + doc.slice(pos);
}

describe('insertHighlightComment', () => {
  test('produces the two inserts and parks the cursor in the comment', () => {
    const edit = insertHighlightComment('hello world', 0, 5);
    expect(edit).toEqual({
      changes: [
        { from: 0, to: 0, insert: '{==' },
        { from: 5, to: 5, insert: '==}{>><<}' },
      ],
      cursor: 14, // to + 9
    });
  });

  test('applying the changes yields the expected markup', () => {
    const edit = insertHighlightComment('hello world', 0, 5)!;
    const result = applyChanges('hello world', edit.changes);
    expect(result).toBe('{==hello==}{>><<} world');
    // Cursor sits between `{>>` and `<<}`.
    expect(result.slice(edit.cursor! - 3, edit.cursor!)).toBe('{>>');
    expect(result.slice(edit.cursor!, edit.cursor! + 3)).toBe('<<}');
  });

  test('returns null when nothing is selected', () => {
    expect(insertHighlightComment('hello', 2, 2)).toBeNull();
  });

  test('embeds a supplied comment (the popup add path)', () => {
    const edit = insertHighlightComment('hello world', 0, 5, 'a note')!;
    expect(applyChanges('hello world', edit.changes)).toBe('{==hello==}{>>a note<<} world');
  });
});

describe('setCommentText', () => {
  test('replaces an existing comment in place', () => {
    const doc = '{==keep==}{>>old<<}';
    const ann = pairAnnotations(parseCriticMarks(doc))[0];
    const edit = setCommentText(doc, ann, 'new note');
    expect(applyChanges(doc, edit.changes)).toBe('{==keep==}{>>new note<<}');
  });

  test('appends a comment to a highlight-only annotation', () => {
    const doc = '{==keep==}';
    const ann = pairAnnotations(parseCriticMarks(doc))[0];
    const edit = setCommentText(doc, ann, 'added');
    expect(applyChanges(doc, edit.changes)).toBe('{==keep==}{>>added<<}');
  });

  test('updates a point comment', () => {
    const doc = 'a {>>old<<} b';
    const ann = pairAnnotations(parseCriticMarks(doc))[0];
    const edit = setCommentText(doc, ann, 'fresh');
    expect(applyChanges(doc, edit.changes)).toBe('a {>>fresh<<} b');
  });
});

describe('removeAnnotation', () => {
  test('highlight + comment leaves the bare highlighted text', () => {
    const doc = '{==keep==}{>>note<<}';
    const ann = pairAnnotations(parseCriticMarks(doc))[0];
    const edit = removeAnnotation(doc, ann);
    expect(edit.cursor).toBeNull();
    expect(applyChanges(doc, edit.changes)).toBe('keep');
  });

  test('point comment is removed entirely', () => {
    const doc = 'a {>>note<<} b';
    const ann = pairAnnotations(parseCriticMarks(doc))[0];
    const edit = removeAnnotation(doc, ann);
    expect(applyChanges(doc, edit.changes)).toBe('a  b');
  });

  test('highlight-only leaves the bare text', () => {
    const doc = '{==kept==}';
    const ann: Annotation = pairAnnotations(parseCriticMarks(doc))[0];
    const edit = removeAnnotation(doc, ann);
    expect(applyChanges(doc, edit.changes)).toBe('kept');
  });
});

describe('changeMarkDecorations', () => {
  /** Compute decos for `doc` (no selection unless given) and tag each with the text it covers. */
  const decosFor = (
    doc: string,
    selections: { from: number; to: number }[] = [],
    allowReveal = false,
  ): (CriticDeco & { text: string })[] =>
    changeMarkDecorations(parseCriticMarks(doc), selections, allowReveal).map((d) => ({
      ...d,
      text: doc.slice(d.from, d.to),
    }));

  test('addition: green add span with both delimiters hidden', () => {
    const decos = decosFor('{++new++}');
    expect(decos).toEqual([
      { from: 3, to: 6, kind: 'add', text: 'new' },
      { from: 0, to: 3, kind: 'hide', text: '{++' },
      { from: 6, to: 9, kind: 'hide', text: '++}' },
    ]);
  });

  test('deletion: red del span with both delimiters hidden', () => {
    const decos = decosFor('{--old--}');
    expect(decos).toEqual([
      { from: 3, to: 6, kind: 'del', text: 'old' },
      { from: 0, to: 3, kind: 'hide', text: '{--' },
      { from: 6, to: 9, kind: 'hide', text: '--}' },
    ]);
  });

  test('substitution: red old span immediately followed by green new span', () => {
    const decos = decosFor('{~~old~>new~~}');
    // del `old`, then the `~>` separator hidden, then add `new`, then the outer delimiters.
    expect(decos).toEqual([
      { from: 3, to: 6, kind: 'del', text: 'old' },
      { from: 6, to: 8, kind: 'hide', text: '~>' },
      { from: 8, to: 11, kind: 'add', text: 'new' },
      { from: 0, to: 3, kind: 'hide', text: '{~~' },
      { from: 11, to: 14, kind: 'hide', text: '~~}' },
    ]);
    // The del span ends exactly where the add span begins (once the `~>` is hidden): adjacent.
    const del = decos.find((d) => d.kind === 'del')!;
    const add = decos.find((d) => d.kind === 'add')!;
    expect(add.from - del.to).toBe(2); // only the hidden `~>` sits between them
  });

  test('substitution with an empty half skips that zero-length span', () => {
    // Empty `new`: a del span + hidden separator + hidden delimiters, no add span.
    expect(decosFor('{~~gone~>~~}').map((d) => d.kind)).toEqual(['del', 'hide', 'hide', 'hide']);
    // Empty `old`: no del span; add span + hidden separator + delimiters.
    expect(decosFor('{~~~>added~~}').map((d) => d.kind)).toEqual(['hide', 'add', 'hide', 'hide']);
  });

  test('substitution with no ~> treats the whole inner as a red del span', () => {
    const decos = decosFor('{~~only~~}');
    expect(decos).toEqual([
      { from: 3, to: 7, kind: 'del', text: 'only' },
      { from: 0, to: 3, kind: 'hide', text: '{~~' },
      { from: 7, to: 10, kind: 'hide', text: '~~}' },
    ]);
  });

  test('no strikethrough/underline is a styling concern — the descriptors carry only add/del/hide', () => {
    const kinds = decosFor('{++a++}{--b--}{~~c~>d~~}').map((d) => d.kind);
    expect(new Set(kinds)).toEqual(new Set(['add', 'del', 'hide']));
  });

  test('reveal (hybrid): a selection touching the mark keeps delimiters visible', () => {
    // Caret inside the addition → delimiters NOT hidden, but the tint span stays.
    const decos = decosFor('{++new++}', [{ from: 4, to: 4 }], true);
    expect(decos).toEqual([{ from: 3, to: 6, kind: 'add', text: 'new' }]);
  });

  test('reveal only when allowed: view mode never reveals even with a caret inside', () => {
    const decos = decosFor('{++new++}', [{ from: 4, to: 4 }], false);
    expect(decos.map((d) => d.kind)).toEqual(['add', 'hide', 'hide']);
  });

  test('a selection OUTSIDE the mark does not reveal it', () => {
    const decos = decosFor('xx {++new++}', [{ from: 0, to: 1 }], true);
    expect(decos.map((d) => d.kind)).toEqual(['add', 'hide', 'hide']);
  });

  test('reveal is per-mark: only the touched substitution stays raw', () => {
    const doc = '{--a--}{~~b~>c~~}';
    // Caret inside the substitution (offsets 7..17) but not the deletion.
    const kinds = decosFor(doc, [{ from: 10, to: 10 }], true).map((d) => d.kind);
    // deletion collapses (del + 2 hides); substitution reveals (del, add only, no hides).
    expect(kinds).toEqual(['del', 'hide', 'hide', 'del', 'add']);
  });

  test('ignores highlight and comment marks (handled by the annotation flow)', () => {
    expect(changeMarkDecorations(parseCriticMarks('{==hi==}{>>note<<}'), [], false)).toEqual([]);
  });

  test('multiple change marks decorated independently in document order', () => {
    const decos = decosFor('{++a++} {--b--}');
    expect(decos.map((d) => [d.kind, d.text])).toEqual([
      ['add', 'a'],
      ['hide', '{++'],
      ['hide', '++}'],
      ['del', 'b'],
      ['hide', '{--'],
      ['hide', '--}'],
    ]);
  });
});
