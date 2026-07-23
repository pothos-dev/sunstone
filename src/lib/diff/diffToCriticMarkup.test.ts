// Unit tests for the pure diff -> CriticMarkup differ. Run with `bun test src/lib`.
// Pins: no-change identity, pure add/delete of blocks, in-word substitution,
// block-marker changes (heading level, list type) -> whole-line replace,
// same-marker content edits -> inline word-level marks, and multi-line prose.
// Every produced review string is asserted to re-parse cleanly via
// `parseCriticMarks` (well-formed, non-overlapping, additions/deletions only).
import { describe, expect, test } from 'bun:test';
import { parseCriticMarks } from '$lib/wasm/exports';
import { diffToCriticMarkup } from './diffToCriticMarkup';

/** Assert the review string re-parses cleanly: every opening delimiter begins a
 *  parsed mark, marks are ordered & non-overlapping, and only additions/deletions
 *  are produced (this differ never emits substitution/comment/highlight marks). */
function assertClean(review: string): void {
  const marks = parseCriticMarks(review);
  for (let i = 1; i < marks.length; i++) {
    expect(marks[i].from).toBeGreaterThanOrEqual(marks[i - 1].to);
  }
  const opens = (review.match(/\{(\+\+|--|~~|==|>>)/g) ?? []).length;
  expect(marks.length).toBe(opens);
  for (const m of marks) expect(['addition', 'deletion']).toContain(m.kind);
}

/** Resolve a review string to the NEW text: drop deletions, unwrap additions. */
const accept = (r: string): string =>
  r.replace(/\{--[\s\S]*?--\}/g, '').replace(/\{\+\+([\s\S]*?)\+\+\}/g, '$1');
/** Resolve a review string to the OLD text: unwrap deletions, drop additions. */
const reject = (r: string): string =>
  r.replace(/\{\+\+[\s\S]*?\+\+\}/g, '').replace(/\{--([\s\S]*?)--\}/g, '$1');

describe('diffToCriticMarkup', () => {
  test('no change returns the input verbatim', () => {
    const doc = '# Hi\n\nsome text\n- a\n- b\n';
    expect(diffToCriticMarkup(doc, doc)).toBe(doc);
  });

  test('pure add: appended block becomes a whole-line addition', () => {
    const review = diffToCriticMarkup('a\nb', 'a\nb\nc');
    expect(review).toBe('a\nb\n{++c++}');
    assertClean(review);
  });

  test('pure add: content into an empty document', () => {
    const review = diffToCriticMarkup('', 'hello');
    expect(review).toBe('{++hello++}');
    assertClean(review);
  });

  test('pure delete: removed line becomes a whole-line deletion', () => {
    const review = diffToCriticMarkup('a\nb\nc', 'a\nc');
    expect(review).toBe('a\n{--b--}\nc');
    assertClean(review);
  });

  test('in-word substitution -> adjacent deletion + addition, rest untouched', () => {
    const review = diffToCriticMarkup('The colour is nice.', 'The color is nice.');
    expect(review).toBe('The {--colour--}{++color++} is nice.');
    assertClean(review);
    expect(reject(review)).toBe('The colour is nice.');
    expect(accept(review)).toBe('The color is nice.');
  });

  test('unchanged tokens are not marked; whitespace/punctuation preserved', () => {
    const review = diffToCriticMarkup('one two three', 'one 2 three');
    // Only the middle token changes; the surrounding spaces stay unmarked.
    expect(review).toBe('one {--two--}{++2++} three');
    assertClean(review);
  });

  test('heading-level change -> whole-line delete + whole-line add (marker not straddled)', () => {
    const review = diffToCriticMarkup('# Title', '## Title');
    expect(review).toBe('{--# Title--}\n{++## Title++}');
    assertClean(review);
  });

  test('marker change still whole-line even when content also changes', () => {
    const review = diffToCriticMarkup('## Old Heading', '### New Heading');
    expect(review).toBe('{--## Old Heading--}\n{++### New Heading++}');
    assertClean(review);
  });

  test('list-type change (- -> 1.) -> whole-line replace', () => {
    const review = diffToCriticMarkup('- item', '1. item');
    expect(review).toBe('{--- item--}\n{++1. item++}');
    assertClean(review);
  });

  test('same heading marker -> inline word diff, `#` kept at line start', () => {
    const review = diffToCriticMarkup('# Old Title', '# New Title');
    expect(review).toBe('# {--Old--}{++New++} Title');
    assertClean(review);
    expect(reject(review)).toBe('# Old Title');
    expect(accept(review)).toBe('# New Title');
  });

  test('same list marker -> inline word diff, `- ` kept at line start', () => {
    const review = diffToCriticMarkup('- buy milk', '- buy bread');
    expect(review).toBe('- buy {--milk--}{++bread++}');
    assertClean(review);
    expect(reject(review)).toBe('- buy milk');
    expect(accept(review)).toBe('- buy bread');
  });

  test('block insert: multi-line insertion, each new line its own addition', () => {
    const review = diffToCriticMarkup('intro\nend', 'intro\n## Section\nbody\nend');
    expect(review).toBe('intro\n{++## Section++}\n{++body++}\nend');
    assertClean(review);
  });

  test('block delete: multi-line deletion, each removed line its own deletion', () => {
    const review = diffToCriticMarkup('intro\n## Section\nbody\nend', 'intro\nend');
    expect(review).toBe('intro\n{--## Section--}\n{--body--}\nend');
    assertClean(review);
  });

  test('multi-line prose edit: unchanged lines untouched, one inline word change', () => {
    const oldText = '# Notes\n\nThe quick brown fox.';
    const newText = '# Notes\n\nThe quick red fox.';
    const review = diffToCriticMarkup(oldText, newText);
    expect(review).toBe('# Notes\n\nThe quick {--brown--}{++red++} fox.');
    assertClean(review);
    expect(reject(review)).toBe(oldText);
    expect(accept(review)).toBe(newText);
  });

  test('word insertion mid-sentence wraps only the added words', () => {
    const review = diffToCriticMarkup('hello world', 'hello brave world');
    expect(review).toBe('hello {++brave ++}world');
    assertClean(review);
    expect(reject(review)).toBe('hello world');
    expect(accept(review)).toBe('hello brave world');
  });

  test('paragraph -> fenced code is a marker change (whole-line replace)', () => {
    const review = diffToCriticMarkup('plain line', '```');
    expect(review).toBe('{--plain line--}\n{++```++}');
    assertClean(review);
  });

  test('several scattered edits -> whole content replaced instead of word soup', () => {
    // Two independent word swaps in one sentence would fragment into
    // `{--quick--}{++slow--} brown {--fox--}{++dog--}`; keep each version whole
    // as one delete chunk followed by one insert chunk.
    const review = diffToCriticMarkup('the quick brown fox', 'the slow brown dog');
    expect(review).toBe('{--the quick brown fox--}{++the slow brown dog++}');
    assertClean(review);
    expect(reject(review)).toBe('the quick brown fox');
    expect(accept(review)).toBe('the slow brown dog');
  });

  test('scattered edits under a shared marker keep the marker at line start', () => {
    const review = diffToCriticMarkup('- the quick brown fox', '- the slow brown dog');
    expect(review).toBe('- {--the quick brown fox--}{++the slow brown dog++}');
    assertClean(review);
    expect(reject(review)).toBe('- the quick brown fox');
    expect(accept(review)).toBe('- the slow brown dog');
  });

  test('a single multi-word change region still shows inline', () => {
    // One contiguous edit region reads fine as a before/after, so it stays inline.
    const review = diffToCriticMarkup('I like cats', 'I like big dogs');
    expect(review).toBe('I like {--cats--}{++big dogs++}');
    assertClean(review);
    expect(reject(review)).toBe('I like cats');
    expect(accept(review)).toBe('I like big dogs');
  });
});
