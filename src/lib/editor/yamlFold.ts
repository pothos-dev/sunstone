// Fold ranges for the Frontmatter YAML editor (ov-15), as pure line logic so it
// is unit-testable without CodeMirror. `frontmatterEditor.ts` wraps it in a
// `foldService` and the fold placeholder.
//
// Folding is by INDENTATION, not the YAML syntax tree: the grammar is lazy-loaded
// and half-typed YAML parses badly, while indentation is always there. A line
// folds when the lines after it are indented deeper (a nested map, a list, a
// list entry, a block scalar), or when it is a `key:` with no value followed by
// a list at the SAME indent (`sources:\n- id: a`, valid YAML). Blank and
// comment lines belong to whatever block surrounds them.

/** A foldable block: the header line and the last line folded under it. */
export interface YamlFold {
  /** 0-based index of the header line (stays visible). */
  header: number;
  /** 0-based index of the last folded line. */
  last: number;
  /** What the placeholder says: `3 entries`, `4 keys`, `12 lines`. */
  summary: string;
}

/** Top-level keys that start folded: the v0.2 lists that grow without bound. */
export const DEFAULT_FOLDED_KEYS = ['sources', 'verified'];

/** `key:` with nothing after it but an optional comment (a block follows). */
const EMPTY_KEY = /^(?:-\s+)?[^\s#'"-][^#]*?:\s*(?:#.*)?$/;
/** A block-scalar header: `key: |`, `key: >-`, … */
const BLOCK_SCALAR = /:\s*[|>][-+0-9]*\s*(?:#.*)?$/;
/** A map key line (`key: …` or `key:`), as opposed to a list item or scalar. */
const KEY_LINE = /^[^\s#'"-][^#]*?:(?:\s|$)/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isStructural(line: string): boolean {
  const t = line.trim();
  return t !== '' && !t.startsWith('#');
}

function isListItem(trimmed: string): boolean {
  return trimmed === '-' || trimmed.startsWith('- ');
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The fold whose header is line `header` (0-based), or null when nothing folds there. */
export function yamlFoldAt(lines: string[], header: number): YamlFold | null {
  const head = lines[header];
  if (head === undefined || !isStructural(head)) return null;
  const indent = indentOf(head);
  const headTrim = head.trimStart();
  // `key:` directly over a same-indent list: the list belongs to the key.
  const compactList = !isListItem(headTrim) && EMPTY_KEY.test(headTrim);

  let last = header;
  let firstChild = -1;
  for (let j = header + 1; j < lines.length; j++) {
    const line = lines[j];
    if (!isStructural(line)) continue;
    const d = indentOf(line);
    const deeper = d > indent;
    const sameIndentItem = compactList && d === indent && isListItem(line.trimStart());
    if (!deeper && !sameIndentItem) break;
    if (firstChild < 0) firstChild = j;
    last = j;
  }
  if (last === header) return null;

  return { header, last, summary: summarize(lines, header, firstChild, last) };
}

function summarize(lines: string[], header: number, firstChild: number, last: number): string {
  const head = lines[header].trimStart();
  if (BLOCK_SCALAR.test(head)) return plural(last - header, 'line', 'lines');
  const childIndent = indentOf(lines[firstChild]);
  const children = lines
    .slice(firstChild, last + 1)
    .filter((l) => isStructural(l) && indentOf(l) === childIndent)
    .map((l) => l.trimStart());
  if (isListItem(children[0])) return plural(children.filter(isListItem).length, 'entry', 'entries');
  const keys = children.filter((c) => KEY_LINE.test(c)).length;
  // A list entry's own first key (`- id: a`) sits on the header line.
  const own = isListItem(head) && KEY_LINE.test(head.slice(1).trimStart()) ? 1 : 0;
  if (keys + own > 0) return plural(keys + own, 'key', 'keys');
  return plural(last - header, 'line', 'lines');
}

/** The folds to apply when a Concept opens: each top-level default-folded key. */
export function defaultYamlFolds(text: string): YamlFold[] {
  const lines = text.split('\n');
  const folds: YamlFold[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (indentOf(line) !== 0) continue;
    const key = /^([A-Za-z_][\w-]*)\s*:/.exec(line)?.[1];
    if (!key || !DEFAULT_FOLDED_KEYS.includes(key)) continue;
    const fold = yamlFoldAt(lines, i);
    if (fold) folds.push(fold);
  }
  return folds;
}
