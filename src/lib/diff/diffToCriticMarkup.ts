// Turn two versions of a document into a single "review" string annotated with
// CriticMarkup marks (the in-memory text ticket 01's decorations render, and
// ticket 04 later feeds into the editor). Pure, CodeMirror-free, IPC-free,
// DOM-free logic so it can be unit-tested over plain strings (project
// convention: pure `.ts`, thin CM wiring elsewhere).
//
// The output re-parses cleanly with the wasm `parseCriticMarks` (`$lib/wasm/exports`)
// — every mark is well-formed and non-overlapping, and no mark ever straddles a
// block marker (see the structure-awareness note below).
//
// Two levels of diffing:
//   1. LINE level: align the old/new lines (LCS) into equal / delete / insert
//      runs. A delete run immediately followed by an insert run is a "replace
//      region": the lines are paired up 1:1 as changed lines; any leftover lines
//      are pure deletes / inserts.
//   2. WORD/TOKEN level, INSIDE a changed line, but only when the two lines share
//      the SAME leading block marker (same heading level, same list marker, …)
//      AND the edit is localized to a SINGLE change region. Then the marker is
//      left untouched at line start and only the differing content tokens are
//      wrapped. Whitespace and punctuation are their own tokens so unchanged
//      structure survives verbatim. When a line has several scattered edits, an
//      inline word diff shreds it into `{--a--}{++b--} … {--d--}{++e--}`
//      fragments where neither version is legible, so we instead replace the
//      whole content as one delete + one add (see MAX_INLINE_CHANGE_REGIONS).
//
// Structure-awareness (WHY): CodeMirror parses the RAW review text and the marks
// are visual-only. Keeping the marker outside the marks — `# {--Old--}{++New++}
// Title` — leaves the `#` at line start so it still parses as a heading. When the
// block markers DIFFER (h1→h2, `-`→`1.`, paragraph→fence, …) there is no shared
// marker to preserve, so the whole old line becomes one `{--…--}` and the whole
// new line one `{++…++}` (whole-line delete + add) rather than straddling a
// marker with an inline mark.
//
// Substitutions are represented as ADJACENT deletion + addition marks
// (`{--old--}{++new++}`), never the `{~~old~>new~~}` form — chosen once and used
// consistently (ticket 01 renders both identically).
//
// v1 limitations (accepted): inline emphasis markers (`**`, `_`, `` ` ``) are
// ordinary tokens and may render raw; whole-line insert/delete/replace keeps each
// mark on its own line, so a stray newline survives if a reviewer later rejects a
// whole-line addition (a rendering/acceptance concern for a later ticket, not a
// re-parse concern).
//
// Known edge cases (documented, not handled): the input is NOT escaped, so text
// that already contains CriticMarkup ends up nested inside our marks
// (`{--a {++b++} c--}`), and a changed span containing a literal closing
// delimiter (`--}` inside a deletion, `++}` inside an addition) closes the mark
// early. Either way the output no longer re-parses to the intended marks.

/** A coalesced run of one diff operation over an array of items (lines or tokens). */
export interface DiffRun {
  op: 'equal' | 'delete' | 'insert';
  items: string[];
}

/**
 * Longest-common-subsequence diff over two string arrays, returned as coalesced
 * runs in output order. Within a replaced region all deletes precede all inserts
 * (the tie-break prefers `delete`), so substitutions surface as `{--old--}` then
 * `{++new++}`.
 *
 * The O(n·m) table is built only over the MIDDLE left after trimming the common
 * prefix and a "safe" common suffix, so a small edit in a large document costs
 * roughly the size of the edit. The trim is exact — the runs are identical to
 * the untrimmed table's (pinned by a reference test):
 *   - the prefix: the backtrack takes a match greedily, so it walks the common
 *     prefix as `equal` whatever the table says, and the table over the rest
 *     (LCS of suffixes) does not depend on the prefix;
 *   - the suffix only while none of its VALUES occurs in either middle: then no
 *     match can pair a middle item with a suffix item, every table entry over
 *     the middle is the middle's entry + the suffix length, and every
 *     delete/insert tie-break comes out the same. (A suffix value that also
 *     occurs in the middle — e.g. a blank line — could be matched there instead,
 *     so such a suffix is shortened until it is safe, falling back to less trim.)
 */
export function lcsDiff(a: string[], b: string[]): DiffRun[] {
  const runs: DiffRun[] = [];
  const push = (op: DiffRun['op'], item: string) => {
    const last = runs[runs.length - 1];
    if (last && last.op === op) last.items.push(item);
    else runs.push({ op, items: [item] });
  };

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    push('equal', a[prefix]);
    prefix++;
  }
  const suffix = safeSuffixLength(a, b, prefix);

  const n = a.length - suffix;
  const m = b.length - suffix;
  const rows = n - prefix;
  const cols = m - prefix;
  // dp[r][c] = LCS length of a[prefix + r .. n) and b[prefix + c .. m).
  const dp: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      dp[r][c] =
        a[prefix + r] === b[prefix + c] ? dp[r + 1][c + 1] + 1 : Math.max(dp[r + 1][c], dp[r][c + 1]);
    }
  }

  let r = 0;
  let c = 0;
  while (r < rows && c < cols) {
    if (a[prefix + r] === b[prefix + c]) {
      push('equal', a[prefix + r]);
      r++;
      c++;
    } else if (dp[r + 1][c] >= dp[r][c + 1]) {
      push('delete', a[prefix + r]);
      r++;
    } else {
      push('insert', b[prefix + c]);
      c++;
    }
  }
  while (r < rows) push('delete', a[prefix + r++]);
  while (c < cols) push('insert', b[prefix + c++]);
  for (let k = n; k < a.length; k++) push('equal', a[k]);
  return runs;
}

/**
 * The longest common suffix of `a` and `b` (after the first `prefix` items)
 * whose values occur in neither remaining middle — the suffix `lcsDiff` may trim
 * without changing its runs (see there). Linear: grows the suffix one item at a
 * time, tracking how often each value still occurs in the middles and how many
 * suffix values are still "in conflict" (occur there).
 */
function safeSuffixLength(a: string[], b: string[], prefix: number): number {
  let common = 0;
  while (
    common < a.length - prefix &&
    common < b.length - prefix &&
    a[a.length - 1 - common] === b[b.length - 1 - common]
  ) {
    common++;
  }
  if (common === 0) return 0;

  // Occurrences of each value in the middles for suffix length 0.
  const inMiddle = new Map<string, number>();
  const count = (v: string, d: number) => inMiddle.set(v, (inMiddle.get(v) ?? 0) + d);
  for (let i = prefix; i < a.length; i++) count(a[i], 1);
  for (let j = prefix; j < b.length; j++) count(b[j], 1);

  const inSuffix = new Set<string>();
  let conflicts = 0; // suffix values that still occur in a middle
  let best = 0;
  for (let s = 1; s <= common; s++) {
    // Move a[n-s] and b[m-s] (equal values) from the middles into the suffix.
    const v = a[a.length - s];
    const wasInSuffix = inSuffix.has(v);
    const before = inMiddle.get(v) ?? 0;
    const after = before - 2;
    inMiddle.set(v, after);
    if (!wasInSuffix) {
      inSuffix.add(v);
      if (after > 0) conflicts++;
    } else if (before > 0 && after === 0) {
      conflicts--;
    }
    if (conflicts === 0) best = s;
  }
  return best;
}

/** A line split into its leading block marker (kept outside marks) and content. */
interface Block {
  /** The leading block marker INCLUDING its trailing space (e.g. `## `, `- `, `> `), or `''`. */
  marker: string;
  /** Everything after the marker (the whole line when there is no marker). */
  content: string;
}

/** Leading block-marker patterns, most specific first. Each captures the marker (incl. trailing space). */
const BLOCK_MARKERS: RegExp[] = [
  /^(#{1,6}\s+)/, // ATX heading
  /^(\s*(?:`{3,}|~{3,}))/, // fenced-code delimiter (info string is content)
  /^(\s*>+\s?)/, // blockquote (any nesting)
  /^(\s*[-*+]\s+)/, // unordered list item
  /^(\s*\d+[.)]\s+)/, // ordered list item
];

/** Split a line into its leading block marker and the remaining content. */
function parseBlock(line: string): Block {
  for (const re of BLOCK_MARKERS) {
    const m = re.exec(line);
    if (m) return { marker: m[1], content: line.slice(m[1].length) };
  }
  return { marker: '', content: line };
}

/**
 * Tokenize a string into runs of letters/digits, runs of whitespace, and single
 * "other" characters (punctuation and inline emphasis markers). Concatenating the
 * tokens reproduces the input exactly, so unchanged tokens round-trip verbatim.
 */
function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+|\s+|[^\p{L}\p{N}\s]/gu) ?? [];
}

// An empty string is never wrapped: `{----}` / `{++++}` (e.g. a deleted or
// inserted BLANK line) is a mark with nothing to review. The blank line itself
// stays in the output unmarked, like any other whole-line mark's own line.
const wrapDel = (s: string): string => (s === '' ? '' : `{--${s}--}`);
const wrapIns = (s: string): string => (s === '' ? '' : `{++${s}++}`);

/**
 * How many inline word-level marks a single changed line may carry before we
 * stop word-diffing it and replace the whole line instead. A "change region" is
 * a maximal stretch of adjacent delete/insert runs (a lone add, a lone delete,
 * or a substitution all count as ONE). At most one such region reads cleanly as
 * a localized edit; two or more scatter the line into `{--a--}{++b--} c
 * {--d--}{++e--}` fragments where neither the old nor the new sentence is
 * legible, so we fall back to a whole-line delete + add.
 */
const MAX_INLINE_CHANGE_REGIONS = 1;

/** Count maximal stretches of adjacent non-`equal` runs (see MAX_INLINE_CHANGE_REGIONS). */
function countChangeRegions(runs: DiffRun[]): number {
  let regions = 0;
  let inChange = false;
  for (const run of runs) {
    if (run.op === 'equal') {
      inChange = false;
    } else if (!inChange) {
      regions++;
      inChange = true;
    }
  }
  return regions;
}

/** Render token-level diff runs into inline CriticMarkup, wrapping only differing tokens. */
function renderRuns(runs: DiffRun[]): string {
  let out = '';
  for (const run of runs) {
    const text = run.items.join('');
    if (run.op === 'equal') out += text;
    else if (run.op === 'delete') out += wrapDel(text);
    else out += wrapIns(text);
  }
  return out;
}

/**
 * Emit the review form of a single changed (old, new) line pair into `out`:
 *   - same leading block marker AND at most one word-level change region → keep
 *     the marker at line start and word-diff the content, so the block still
 *     parses and a localized edit shows inline;
 *   - same marker but several scattered edits → keep the shared marker but
 *     replace the whole content (one delete + one add) so each version reads as
 *     a whole line instead of a shredded word soup;
 *   - different markers → whole-line delete + whole-line add, on separate lines.
 */
function emitChangedLine(oldLine: string, newLine: string, out: string[]): void {
  const o = parseBlock(oldLine);
  const n = parseBlock(newLine);
  if (o.marker !== n.marker) {
    out.push(wrapDel(oldLine));
    out.push(wrapIns(newLine));
    return;
  }
  if (o.content === n.content) {
    out.push(oldLine);
    return;
  }
  const runs = lcsDiff(tokenize(o.content), tokenize(n.content));
  if (countChangeRegions(runs) > MAX_INLINE_CHANGE_REGIONS) {
    // Whole content as one delete chunk + one insert chunk, marker kept at line
    // start. Reads the full old sentence then the full new one, round-trips
    // cleanly (reject → marker+old, accept → marker+new), and the block still
    // parses since the marker is not straddled.
    out.push(o.marker + wrapDel(o.content) + wrapIns(n.content));
    return;
  }
  out.push(o.marker + renderRuns(runs));
}

/**
 * Diff two document versions into a single CriticMarkup "review" string.
 *
 * Unchanged tokens stay unmarked; only differences are wrapped. Changes stay
 * structure-aware (see the module header): inline word-level marks inside a block
 * when the block marker is stable, whole-line delete/add when it changes or when
 * a whole block is inserted/deleted. The result re-parses cleanly with
 * `parseCriticMarks`.
 */
export function diffToCriticMarkup(oldText: string, newText: string): string {
  if (oldText === newText) return oldText;

  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const runs = lcsDiff(oldLines, newLines);

  const out: string[] = [];
  for (let k = 0; k < runs.length; k++) {
    const run = runs[k];
    if (run.op === 'equal') {
      for (const line of run.items) out.push(line);
    } else if (run.op === 'delete') {
      const next = runs[k + 1];
      if (next && next.op === 'insert') {
        // Replace region: pair old/new lines 1:1, leftovers are pure del/ins.
        const dels = run.items;
        const inss = next.items;
        const paired = Math.min(dels.length, inss.length);
        for (let p = 0; p < paired; p++) emitChangedLine(dels[p], inss[p], out);
        for (let p = paired; p < dels.length; p++) out.push(wrapDel(dels[p]));
        for (let p = paired; p < inss.length; p++) out.push(wrapIns(inss[p]));
        k++; // consumed the following insert run
      } else {
        for (const line of run.items) out.push(wrapDel(line));
      }
    } else {
      // Insert run not preceded by a delete run (a pure block insert).
      for (const line of run.items) out.push(wrapIns(line));
    }
  }
  return out.join('\n');
}
