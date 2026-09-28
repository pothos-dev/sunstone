// Unit tests for the pure diff -> CriticMarkup differ. Run with `bun test src/lib`.
// Pins: no-change identity, pure add/delete of blocks, in-word substitution,
// block-marker changes (heading level, list type) -> whole-line replace,
// same-marker content edits -> inline word-level marks, and multi-line prose.
// Every produced review string is asserted to re-parse cleanly via
// `parseCriticMarks` (well-formed, non-overlapping, additions/deletions only).
import { describe, expect, test } from 'bun:test';
import { parseCriticMarks } from '$lib/wasm/exports';
import { diffToCriticMarkup, lcsDiff, type DiffRun } from './diffToCriticMarkup';

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

describe('blank lines', () => {
  test('a deleted blank line emits no empty mark', () => {
    const review = diffToCriticMarkup('a\n\nb', 'a\nb');
    expect(review).not.toContain('{----}');
    expect(review).toBe('a\n\nb');
    assertClean(review);
  });

  test('an inserted blank line emits no empty mark', () => {
    const review = diffToCriticMarkup('a\nb', 'a\n\nb');
    expect(review).not.toContain('{++++}');
    expect(review).toBe('a\n\nb');
    assertClean(review);
  });

  test('a blank line replaced by a heading marks only the heading', () => {
    const review = diffToCriticMarkup('a\n\nb', 'a\n# x\nb');
    expect(review).toBe('a\n\n{++# x++}\nb');
    assertClean(review);
  });
});

/** The untrimmed O(n*m) LCS the trimmed `lcsDiff` must reproduce exactly. */
function referenceLcsDiff(a: string[], b: string[]): DiffRun[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const runs: DiffRun[] = [];
  const push = (op: DiffRun['op'], item: string) => {
    const last = runs[runs.length - 1];
    if (last && last.op === op) last.items.push(item);
    else runs.push({ op, items: [item] });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('equal', a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('delete', a[i]);
      i++;
    } else {
      push('insert', b[j]);
      j++;
    }
  }
  while (i < n) push('delete', a[i++]);
  while (j < m) push('insert', b[j++]);
  return runs;
}

describe('lcsDiff prefix/suffix trimming', () => {
  test('matches the untrimmed LCS on the suffix-ambiguity cases', () => {
    const cases: [string[], string[]][] = [
      [['x', 'y'], ['y', 'y']],
      [['y', 'y'], ['y']],
      [['p', 'y', 'y'], ['q', 'y']],
      [['a', '', 'b', '', 'c'], ['a', '', 'B', '', 'c']],
      [[], ['a']],
      [['a'], []],
    ];
    for (const [a, b] of cases) expect(lcsDiff(a, b)).toEqual(referenceLcsDiff(a, b));
  });

  test('matches the untrimmed LCS on random small-alphabet inputs', () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const alphabet = ['a', 'b', 'c', ''];
    const gen = (len: number) => Array.from({ length: len }, () => alphabet[Math.floor(rand() * alphabet.length)]);
    for (let k = 0; k < 2000; k++) {
      const a = gen(Math.floor(rand() * 9));
      // Half the time derive b from a by a small edit, so prefixes/suffixes are shared.
      const b = rand() < 0.5 ? gen(Math.floor(rand() * 9)) : [...a];
      if (b.length > 0 && rand() < 0.7) b[Math.floor(rand() * b.length)] = alphabet[Math.floor(rand() * 4)];
      if (rand() < 0.3) b.splice(Math.floor(rand() * (b.length + 1)), 0, alphabet[Math.floor(rand() * 4)]);
      expect(lcsDiff(a, b)).toEqual(referenceLcsDiff(a, b));
    }
  });

  test('a small edit in a large document diffs fast and marks only the edit', () => {
    const lines: string[] = [];
    for (let p = 0; p < 4000; p++) lines.push(`Paragraph ${p} says something.`, '');
    const oldText = lines.join('\n');
    const edited = [...lines];
    edited[4000] = 'Paragraph 2000 says something new.';
    const newText = edited.join('\n');

    const t0 = performance.now();
    const review = diffToCriticMarkup(oldText, newText);
    const elapsed = performance.now() - t0;

    const expected = [...lines];
    expected[4000] = 'Paragraph 2000 says something{++ new++}.';
    expect(review).toBe(expected.join('\n'));
    // An 8000x8000 table used to take seconds; the trimmed middle is 1x1.
    expect(elapsed).toBeLessThan(250);
  });
});
