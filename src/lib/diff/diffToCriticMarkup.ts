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

/** A coalesced run of one diff operation over an array of items (lines or tokens). */
interface DiffRun {
  op: 'equal' | 'delete' | 'insert';
  items: string[];
}

/**
 * Longest-common-subsequence diff over two string arrays, returned as coalesced
 * runs in output order. Within a replaced region all deletes precede all inserts
 * (the tie-break prefers `delete`), so substitutions surface as `{--old--}` then
 * `{++new++}`.
 */
function lcsDiff(a: string[], b: string[]): DiffRun[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..].
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

const wrapDel = (s: string): string => `{--${s}--}`;
const wrapIns = (s: string): string => `{++${s}++}`;

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
