// The OKF language service's lint half (ADR 0009, ov-3): `lintFrontmatter`.
//
// Pure, DOM-free and editor-free: it takes the Frontmatter YAML block and a
// mode, parses ONCE, and returns findings with character offsets. The
// Frontmatter editor runs it through `@codemirror/lint` (`editor/yamlLanguage`).
//
//   mode 'yaml' — well-formedness only: parse errors and duplicate keys. This
//                 is what every Bundle gets, OKF or not.
//   mode 'okf'  — the above, plus every OKF family the Concept opted into
//                 (`./families`). Only a Bundle whose root `index.md` declares
//                 `okf_version` gets this (see `./mode.ts`).
//
// The save gate does NOT ask this (it asks `isParseable` in `$lib/frontmatter`),
// so whether a Concept saves can never drift with lint policy.

import { isMap, isSeq, parseDocument, YAMLMap, type Document, type Node, type Pair } from 'yaml';
import {
  isEmptyValue,
  lineFrom,
  pairRange,
  rangeOf,
  type Finding,
  type Located,
  type OkfFamily,
  type Path,
  type Range,
  type RequiredKey,
  type RuleContext,
  type Severity,
} from './family';
import { OKF_FAMILIES } from './families';

/** Which rules apply: well-formedness only, or well-formedness plus OKF. */
export type LintMode = 'yaml' | 'okf';

/**
 * Lint a Frontmatter block (the inner YAML, no `---` fences). Findings are
 * sorted by position. `families` defaults to the registered set; tests pass
 * their own.
 */
export function lintFrontmatter(
  yaml: string,
  mode: LintMode,
  families: readonly OkfFamily[] = OKF_FAMILIES,
): Finding[] {
  let doc: Document.Parsed;
  try {
    // Default `uniqueKeys: true`, unlike the save gate: here a duplicate key is
    // exactly what we want reported.
    doc = parseDocument(yaml);
  } catch (e) {
    return [finding([0, yaml.length], 'error', e instanceof Error ? e.message : String(e), 'yaml')];
  }

  const findings: Finding[] = [];
  let malformed = false;
  for (const err of doc.errors) {
    const [from, to] = clampRange(yaml, err.pos);
    if (err.code === 'DUPLICATE_KEY') {
      const key = keyAt(yaml, from);
      findings.push(finding([from, key ? from + key.length : to], 'error', `Duplicate key \`${key}\``, 'yaml'));
    } else {
      malformed = true;
      findings.push(finding([from, to], 'error', firstLine(err.message), 'yaml'));
    }
  }

  // OKF rules need a document to reason about; on a block that does not parse
  // they would only add noise to the error the author is already fixing.
  if (mode === 'okf' && !malformed) findings.push(...lintOkf(yaml, doc, families));

  return findings.sort((a, b) => a.from - b.from || a.to - b.to);
}

function lintOkf(yaml: string, doc: Document.Parsed, families: readonly OkfFamily[]): Finding[] {
  const contents = doc.contents;
  if (contents !== null && !isMap(contents)) {
    const range = rangeOf(contents, [0, yaml.length]);
    return [finding(range, 'error', 'OKF Frontmatter must be a mapping of keys, with at least `type` (OKF §4.1)', 'okf')];
  }
  const root = (contents as YAMLMap | null) ?? new YAMLMap();
  const out: Finding[] = [];
  for (const family of families) {
    if (!optedIn(family, root)) continue;
    const ctx = contextFor(yaml, doc, root, family.id);
    for (const req of family.required ?? []) out.push(...checkRequired(ctx, req));
    for (const rule of family.rules ?? []) out.push(...rule(ctx));
  }
  return out;
}

/** A family runs when it is always-on or any of its top-level keys is present. */
function optedIn(family: OkfFamily, root: YAMLMap): boolean {
  return family.keys.length === 0 || family.keys.some((k) => root.has(k));
}

function contextFor(yaml: string, doc: Document.Parsed, root: YAMLMap, source: string): RuleContext {
  const ctx: RuleContext = {
    yaml,
    doc,
    root,
    pair: pairOf,
    nodesAt(path: Path): Located[] {
      const rootAnchor: Range = root.range ? lineFrom(yaml, root.range[0]) : [0, 0];
      let located: Located[] = [{ node: root, anchor: rootAnchor }];
      for (const segment of path) {
        const next: Located[] = [];
        for (const { node } of located) {
          if (segment === '*') {
            if (!isSeq(node)) continue;
            for (const item of node.items as Node[]) {
              // The item itself, clipped to its first line.
              const [start, end] = rangeOf(item, [0, 0]);
              next.push({ node: item, anchor: [start, Math.min(end, lineFrom(yaml, start)[1])] });
            }
          } else if (isMap(node)) {
            const p = pairOf(node, segment);
            if (p) next.push({ node: (p.value as Node | null) ?? null, anchor: rangeOf(p.key, [0, 0]) });
          }
        }
        located = next;
      }
      return located;
    },
    at: (range, severity, message) => finding(range, severity, message, source),
  };
  return ctx;
}

function pairOf(map: YAMLMap, key: string): Pair | null {
  for (const item of map.items) {
    const k = item.key as { value?: unknown } | null;
    if (k && typeof k === 'object' && k.value === key) return item as Pair;
  }
  return null;
}

/** REQUIRED fields (spec §4.1, §5.1, §5.2) are errors — the ADR's one hard line. */
function checkRequired(ctx: RuleContext, req: RequiredKey): Finding[] {
  const out: Finding[] = [];
  const cite = req.spec ? ` (OKF ${req.spec})` : '';
  const where = req.path.length ? ` in \`${pathLabel(req.path)}\`` : '';
  for (const { node, anchor } of ctx.nodesAt(req.path)) {
    // An empty `generated:` is an empty map for this purpose; any other
    // non-map shape is the owning family's own rule to report.
    if (!isMap(node) && !isEmptyValue(node)) continue;
    const p = isMap(node) ? ctx.pair(node, req.key) : null;
    if (!p) {
      out.push(ctx.at(anchor, 'error', `Missing required key \`${req.key}\`${where}${cite}`));
    } else if (isEmptyValue(p.value)) {
      out.push(ctx.at(pairRange(p, anchor), 'error', `\`${req.key}\` is required but empty${where}${cite}`));
    }
  }
  return out;
}

/** `['sources', '*']` → `sources[]`. */
function pathLabel(path: Path): string {
  return path.reduce((acc, seg) => (seg === '*' ? `${acc}[]` : acc ? `${acc}.${seg}` : seg), '');
}

function finding(range: Range, severity: Severity, message: string, source: string): Finding {
  return { from: range[0], to: range[1], severity, message, source };
}

function clampRange(yaml: string, [from, to]: [number, number]): Range {
  const max = yaml.length;
  const f = Math.min(Math.max(from, 0), max);
  return [f, Math.min(Math.max(to, f), max)];
}

/** The key text starting at `offset` (up to the `:`), for duplicate-key messages. */
function keyAt(yaml: string, offset: number): string {
  return /^[^:\n]*/.exec(yaml.slice(offset))![0].trim();
}

/** The `yaml` package appends a source excerpt after the first line; drop it. */
function firstLine(message: string): string {
  return message.split('\n')[0].replace(/:$/, '');
}
