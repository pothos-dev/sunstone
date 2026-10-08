// The OKF language service's completion half (ADR 0009, ov-3):
// `completeFrontmatter`. Replaces the Properties panel's `OKF_KEYS` autocomplete.
//
// Pure: given the YAML block and a cursor offset it works out WHERE the cursor
// is (a key position inside the map at some path, or the value of some key)
// and collects what the registered families offer there. The path comes from
// INDENTATION, not a parse, because the block is half-typed whenever completion
// is wanted — the same trade `editor/yamlFold` makes. Flow collections
// (`{ by: x }`) are not completed.

import type { CompletionOption, CompletionSpec, OkfFamily, Path } from './family';
import { OKF_FAMILIES } from './families';
import type { LintMode } from './lint';

export interface FrontmatterCompletion {
  /** Start of the text the chosen option replaces (the cursor is the end). */
  from: number;
  /** Whether the cursor is at a key or at a value. */
  kind: 'key' | 'value';
  /** What was already typed (`from`..cursor). */
  prefix: string;
  options: CompletionOption[];
}

/**
 * The completions at `pos` in `yaml`, or `null` when there are none — always
 * `null` outside OKF mode (ADR 0009: completion is gated with lint). Key
 * options default to inserting `key: `; keys already present beside the cursor
 * are left out.
 */
export function completeFrontmatter(
  yaml: string,
  pos: number,
  mode: LintMode,
  families: readonly OkfFamily[] = OKF_FAMILIES,
): FrontmatterCompletion | null {
  if (mode !== 'okf') return null;
  const lines = yaml.split('\n');
  const lineStart = yaml.lastIndexOf('\n', pos - 1) + 1;
  const lineIdx = yaml.slice(0, lineStart).split('\n').length - 1;
  const before = yaml.slice(lineStart, pos);
  const after = lines[lineIdx].slice(before.length);
  // Only at the end of what is on the line: never splice into existing text.
  if (after.trim() !== '') return null;
  const infos = lines.map(lineInfo);

  const keyPos = /^( *)(- +)?([\w.-]*)$/.exec(before);
  if (keyPos) {
    const [, indent, dash = '', prefix] = keyPos;
    const path = pathAt(infos, lineIdx, indent.length, dash.length);
    if (!path) return null;
    const present = siblingKeys(infos, lineIdx, indent.length + dash.length, dash !== '');
    const options = collect(families, path, 'keys')
      .filter((o) => !present.has(o.label))
      .map((o) => ({ ...o, apply: o.apply ?? `${o.label}: ` }));
    return result(pos - prefix.length, 'key', prefix, options);
  }

  const valuePos = /^( *)(- +)?([\w.-]+): +([^\s#]*)$/.exec(before);
  if (valuePos) {
    const [, indent, dash = '', key, prefix] = valuePos;
    const path = pathAt(infos, lineIdx, indent.length, dash.length);
    if (!path) return null;
    return result(pos - prefix.length, 'value', prefix, collect(families, [...path, key], 'values'));
  }
  return null;
}

function result(
  from: number,
  kind: 'key' | 'value',
  prefix: string,
  options: CompletionOption[],
): FrontmatterCompletion | null {
  return options.length ? { from, kind, prefix, options } : null;
}

/** Every family's options at exactly `path`, first offer of a label winning. */
function collect(families: readonly OkfFamily[], path: Path, what: 'keys' | 'values'): CompletionOption[] {
  const seen = new Set<string>();
  const out: CompletionOption[] = [];
  for (const family of families) {
    for (const spec of family.completions ?? []) {
      if (!samePath(spec, path)) continue;
      for (const option of spec[what] ?? []) {
        if (seen.has(option.label)) continue;
        seen.add(option.label);
        out.push(option);
      }
    }
  }
  return out;
}

function samePath(spec: CompletionSpec, path: Path): boolean {
  return spec.path.length === path.length && spec.path.every((seg, i) => seg === path[i]);
}

// --- indentation model ---------------------------------------------------------

interface LineInfo {
  /** Blank or comment-only: ignored by every walk. */
  skip: boolean;
  /** Leading spaces. */
  indent: number;
  /** Starts a list item (`- `). */
  dash: boolean;
  /** Column the content starts at (after any `- `). */
  col: number;
  /** The key at `col`, when the content is `key:`. */
  key: string | null;
  /** Whether that key has a value on the same line (so it is no block parent). */
  inline: boolean;
}

function lineInfo(text: string): LineInfo {
  const m = /^( *)(- +|-$)?(.*)$/.exec(text)!;
  const indent = m[1].length;
  const dash = m[2] !== undefined;
  const rest = m[3];
  const skip = !dash && (rest.trim() === '' || rest.trimStart().startsWith('#'));
  const k = /^([\w.-]+) *:(?: +(.*))?$/.exec(rest.trimEnd());
  const value = k?.[2]?.trim() ?? '';
  return {
    skip,
    indent,
    dash,
    col: indent + (m[2]?.length ?? 0),
    key: k ? k[1] : null,
    inline: value !== '' && !value.startsWith('#'),
  };
}

/**
 * The map path of a key typed on line `at`, starting at column `indent` (after
 * a `- ` of `dashLen` when the line opens a list item). `null` when the
 * indentation does not describe a block structure we can follow.
 */
function pathAt(infos: LineInfo[], at: number, indent: number, dashLen: number): string[] | null {
  const path: string[] = [];
  let col = indent + dashLen;
  // `seq`: we are inside a list item whose dash sits at column `col`, and the
  // next thing to find is the key that owns the list.
  let seq = false;
  if (dashLen > 0) {
    path.unshift('*');
    col = indent;
    seq = true;
  }
  for (let j = at - 1; j >= 0 && (col > 0 || seq); j--) {
    const ln = infos[j];
    if (ln.skip) continue;
    if (seq) {
      if (ln.indent > col || (ln.dash && ln.indent === col)) continue; // a sibling item
      if (!ln.key || ln.inline || ln.col > col) return null;
      path.unshift(ln.key);
      seq = false;
      col = ln.col;
      if (ln.dash) {
        path.unshift('*');
        col = ln.indent;
        seq = true;
      }
      continue;
    }
    if (ln.dash && ln.col === col) {
      // The first line of the list item this key continues.
      path.unshift('*');
      col = ln.indent;
      seq = true;
      continue;
    }
    if (ln.col >= col) continue; // a sibling or something deeper
    if (ln.key && !ln.inline) {
      path.unshift(ln.key);
      col = ln.col;
      if (ln.dash) {
        path.unshift('*');
        col = ln.indent;
        seq = true;
      }
      continue;
    }
    if (ln.dash && ln.key === null) {
      path.unshift('*');
      col = ln.indent;
      seq = true;
      continue;
    }
    return null;
  }
  return col === 0 && !seq ? path : null;
}

/** Keys already present in the map the cursor's key belongs to (excl. its line). */
function siblingKeys(infos: LineInfo[], at: number, col: number, opensItem: boolean): Set<string> {
  const keys = new Set<string>();
  if (!opensItem) {
    for (let j = at - 1; j >= 0; j--) {
      const ln = infos[j];
      if (ln.skip || ln.col > col) continue;
      if (ln.col < col) break;
      if (ln.key) keys.add(ln.key);
      if (ln.dash) break; // the start of this list item
    }
  }
  for (let j = at + 1; j < infos.length; j++) {
    const ln = infos[j];
    if (ln.skip || ln.col > col) continue;
    if (ln.col < col || ln.dash) break;
    if (ln.key) keys.add(ln.key);
  }
  return keys;
}
