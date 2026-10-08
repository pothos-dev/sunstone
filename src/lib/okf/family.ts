// The contract a Frontmatter key FAMILY implements to plug into the OKF
// language service (ADR 0009, ov-3).
//
// The service (`./lint.ts`, `./complete.ts`) knows nothing about any one family:
// it walks `OKF_FAMILIES` (`./families/index.ts`) and asks each for its required
// keys, its rules and its completions. A family ticket (trust ov-9, provenance
// ov-10, lifecycle ov-11, computation ov-12) adds behaviour by editing ITS OWN
// module under `./families/` — never a switch in the service.
//
// Scoping: a family whose `keys` are all absent from a Concept's top level is
// skipped entirely, so a Concept with no `sources` gets no provenance findings
// (ADR 0009 "Consequences"). The core family (`keys: []`) always runs.

import { isScalar, type Document, type Node, type Pair, type YAMLMap } from 'yaml';

/** How a finding should be weighted. The spec's REQUIRED fields are `error`. */
export type Severity = 'error' | 'warning' | 'info';

/** One lint result, positioned by character offsets into the YAML block. */
export interface Finding {
  from: number;
  to: number;
  severity: Severity;
  message: string;
  /** Who raised it: `yaml` for well-formedness, else the family `id`. */
  source: string;
}

/**
 * A path into the Frontmatter: map keys, with `'*'` standing for every item of
 * a list. `[]` is the top level; `['sources', '*']` is each `sources` entry.
 */
export type Path = readonly string[];

/** A key the spec marks REQUIRED inside every map at `path` (an error when absent). */
export interface RequiredKey {
  path: Path;
  key: string;
  /** Spec section to cite in the message, e.g. `§5.2`. */
  spec?: string;
}

/** A completion candidate: a key name or a scalar value. */
export interface CompletionOption {
  label: string;
  /** Short hint shown beside the label. */
  detail?: string;
  /** Longer description (the completion info panel). */
  info?: string;
  /** Text to insert instead of the default (`label: ` for a key, `label` for a value). */
  apply?: string;
}

/**
 * Completions a family offers at one place in the Frontmatter. `keys` are
 * offered when the cursor is at a key position inside the map at `path`;
 * `values` when it is at the value of the key `path` ends with.
 *
 * Top-level keys (`path: []`) are offered in every OKF Concept — they are how
 * an author opts INTO a family. Nested paths only ever match once the family's
 * key is already present, which is the "keys of any family already present"
 * half of the contract.
 */
export interface CompletionSpec {
  path: Path;
  keys?: CompletionOption[];
  values?: CompletionOption[];
}

/** Everything a rule gets to inspect: the parsed block plus position helpers. */
export interface RuleContext {
  /** The YAML block the offsets refer to. */
  yaml: string;
  /** The parsed document (well-formed: rules never see a block that failed to parse). */
  doc: Document.Parsed;
  /** The top-level map. Rules only run when the block is a map (or empty). */
  root: YAMLMap;
  /** The map entry for `key` in `map`, or `null`. */
  pair(map: YAMLMap, key: string): Pair | null;
  /** Every node at `path` (`'*'` expands each list item), each with an anchor range. */
  nodesAt(path: Path): Located[];
  /** A finding spanning `node`'s source text (or the anchor, for a whole map). */
  at(range: Range, severity: Severity, message: string): Finding;
}

/** A `[from, to)` character range into the YAML block. */
export type Range = readonly [number, number];

/** A node found by `nodesAt`, with the range a finding about it should mark. */
export interface Located {
  node: Node | null;
  /** The key (or list dash line) naming this node: where "missing X here" points. */
  anchor: Range;
}

/** A lint rule: inspect the block, return findings (empty when happy). */
export type OkfRule = (ctx: RuleContext) => Finding[];

/** A Frontmatter key family plugged into the language service. */
export interface OkfFamily {
  /** Stable id; also the `source` of this family's findings. */
  id: string;
  /**
   * Top-level keys whose presence opts a Concept into this family. `[]` means
   * always on (the §4.1 core). Required keys and rules run only when opted in.
   */
  keys: readonly string[];
  /** Fields the spec marks REQUIRED: reported as errors when missing or empty. */
  required?: readonly RequiredKey[];
  /** Anything else this family checks — warnings or info, by the ADR's rule. */
  rules?: readonly OkfRule[];
  /** Keys and values this family offers to complete. */
  completions?: readonly CompletionSpec[];
}

// --- helpers shared by rules ---------------------------------------------------

/** Whether `node` is a plain string scalar. */
export function isStringScalar(node: unknown): boolean {
  return isScalar(node) && typeof node.value === 'string';
}

/** Whether `node` is absent, `null`, or an empty / whitespace-only string. */
export function isEmptyValue(node: unknown): boolean {
  if (node === null || node === undefined) return true;
  if (!isScalar(node)) return false;
  return node.value === null || (typeof node.value === 'string' && node.value.trim() === '');
}

/** The source range of a node, or `fallback` when it has none. */
export function rangeOf(node: unknown, fallback: Range): Range {
  if (node && typeof node === 'object' && 'range' in node) {
    const r = (node as { range?: [number, number, number] | null }).range;
    if (r) return [r[0], Math.max(r[1], r[0])];
  }
  return fallback;
}

/** The pair's key + value span, for "this entry is wrong" findings. */
export function pairRange(pair: Pair, fallback: Range): Range {
  const from = rangeOf(pair.key, fallback)[0];
  const to = pair.value ? rangeOf(pair.value, fallback)[1] : rangeOf(pair.key, fallback)[1];
  return [from, Math.max(to, from)];
}

/** The rest of the line starting at `offset` (trailing whitespace dropped). */
export function lineFrom(yaml: string, offset: number): Range {
  const nl = yaml.indexOf('\n', offset);
  const end = nl === -1 ? yaml.length : nl;
  return [offset, offset + yaml.slice(offset, end).trimEnd().length];
}
