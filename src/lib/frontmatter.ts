// Frontmatter parsing + serialization for the Properties panel.
//
// ADR 0003 (structured, re-serialized frontmatter — supersedes ADR 0002): the
// Properties panel holds frontmatter as a structured `Property[]` (the single
// source of truth, owned by a CodeMirror StateField) and re-serializes the
// WHOLE YAML block from that structure on every change. Scalars and flat lists
// are re-emitted from their parsed form; `complex` entries (nested maps,
// non-flat sequences, multi-line/block scalars) and unknown keys are re-emitted
// VERBATIM from their captured source `entry` text, so OKF conformance holds
// (required `type` preserved; unknown keys round-trip untouched — OKF §9). The
// trade-off vs ADR 0002: comments and the original quoting/formatting of edited
// simple values are normalized, not preserved byte-for-byte.
//
// Kept dependency-free of the IPC seam: operates purely on raw markdown strings.
// `parseProperties` splits a Concept into properties (via the wasm-free
// `splitFrontmatter`, ADR 0006 §11-B) and classifies them per ADR 0003;
// `serializeFrontmatter` / `joinConcept` recombine them with a body.

import { parseDocument, isScalar, isSeq, isMap, isNode, Scalar, type Document } from 'yaml';
import { basename, stripMd } from './path';
// `splitFrontmatter` is now a pure wasm FREE export (ADR 0006 §11-B); the
// property model consumes it on Concept-load. Single source — no TS twin.
import { splitFrontmatter } from '$lib/wasm/exports';

/** Classification of a top-level frontmatter value (ADR 0003). */
export type PropertyKind = 'scalar' | 'list' | 'complex';

/** One top-level frontmatter entry, in document order. */
export interface Property {
  key: string;
  kind: PropertyKind;
  /** Scalar string form (empty string for null/empty). Only for `scalar`. */
  scalar?: string;
  /** Whether the scalar parsed as a boolean (affects re-serialization). */
  boolean?: boolean;
  /**
   * Whether the scalar parsed as a number (int/float). Re-serialized unquoted
   * so an integer/float keeps its YAML type across a round-trip instead of
   * being force-quoted into a string (ADR 0003).
   */
  number?: boolean;
  /** Flat list items as strings. Only for `list`. */
  list?: string[];
  /** Verbatim source text of the VALUE (shown read-only for `complex`). */
  raw?: string;
  /**
   * Verbatim source of the WHOLE entry (`key:` + value + trailing newline) for
   * `complex` properties. Re-emitted unchanged during whole-block
   * re-serialization so nested maps, block scalars, and unknown keys round-trip
   * byte-for-byte (ADR 0003).
   */
  entry?: string;
}

/**
 * Parse the top-level frontmatter entries of a Concept into an ordered list of
 * Properties, classifying each per ADR 0003. Returns an empty list when there
 * is no frontmatter (the Properties panel then opens collapsed by default).
 */
export function parseProperties(content: string): Property[] {
  const { hasFrontmatter, yaml } = splitFrontmatter(content);
  if (!hasFrontmatter || yaml.trim() === '') return [];

  let doc: Document.Parsed;
  try {
    doc = parseDocument(yaml, { keepSourceTokens: true });
  } catch {
    return [];
  }
  if (!isMap(doc.contents)) return [];

  const props: Property[] = [];
  for (const item of doc.contents.items) {
    const key = scalarKeyString(item.key);
    if (key === null) continue;
    const prop = classify(key, item.value, yaml);
    // For `complex` entries, also capture the WHOLE entry source so the
    // serializer can re-emit it verbatim (ADR 0003).
    if (prop.kind === 'complex') {
      prop.entry = entryText(item.key, item.value, yaml);
    }
    props.push(prop);
  }
  return props;
}

/**
 * Capture the verbatim source of a whole frontmatter entry — from the start of
 * its key to the end of the entry's last line (including the trailing newline).
 * Used to round-trip `complex`/unknown entries unchanged during re-serialization.
 */
function entryText(keyNode: unknown, valueNode: unknown, yamlSrc: string): string {
  const keyRange = isNode(keyNode) ? keyNode.range : undefined;
  if (!keyRange) return '';
  const start = keyRange[0];
  const valueRange = (valueNode as { range?: [number, number, number] } | null)?.range;
  let end: number;
  if (valueRange) {
    end = valueRange[1];
  } else {
    const nl = yamlSrc.indexOf('\n', keyRange[1]);
    end = nl === -1 ? yamlSrc.length : nl;
  }
  // Extend to include the rest of the current line + its newline, unless the
  // value range already ended exactly on a line break (block constructs do).
  if (end > 0 && yamlSrc[end - 1] !== '\n') {
    const nl = yamlSrc.indexOf('\n', end);
    end = nl === -1 ? yamlSrc.length : nl + 1;
  }
  return yamlSrc.slice(start, end);
}

/**
 * Whether the required `type` field is missing or empty (the one OKF
 * conformance rule we flag). Reserved files (`index.md`/`log.md`) are exempt —
 * that exemption is applied by the caller in a later slice; here we report the
 * raw condition. A Concept with no frontmatter at all reports `true`.
 */
export function isTypeMissing(props: Property[]): boolean {
  const t = props.find((p) => p.key === 'type');
  if (!t) return true;
  if (t.kind === 'scalar') return (t.scalar ?? '').trim() === '';
  // A non-scalar `type` is malformed for our purposes — flag it.
  return t.kind !== 'list' || (t.list?.length ?? 0) === 0;
}

/** Classify a single value node into a Property. */
function classify(key: string, value: unknown, yamlSrc: string): Property {
  // Scalars: string / number / bool / null / date.
  if (value === null || value === undefined) {
    return { key, kind: 'scalar', scalar: '' };
  }
  if (isScalar(value)) {
    // Multi-line block scalars (literal `|` / folded `>`) are NOT simple
    // single-line scalars — per ADR 0003 they are preserved verbatim as a
    // read-only raw field rather than edited as a text input.
    const type = (value as Scalar).type;
    if (type === Scalar.BLOCK_LITERAL || type === Scalar.BLOCK_FOLDED) {
      return { key, kind: 'complex', raw: rangeText(value, yamlSrc) };
    }
    const v = (value as Scalar).value;
    if (typeof v === 'boolean') {
      return { key, kind: 'scalar', scalar: String(v), boolean: true };
    }
    if (typeof v === 'number' || typeof v === 'bigint') {
      return { key, kind: 'scalar', scalar: String(v), number: true };
    }
    if (v === null) return { key, kind: 'scalar', scalar: '' };
    // A string scalar that itself spans multiple lines is also not a simple
    // single-line field — preserve verbatim.
    if (typeof v === 'string' && v.includes('\n')) {
      return { key, kind: 'complex', raw: rangeText(value, yamlSrc) };
    }
    return { key, kind: 'scalar', scalar: String(v) };
  }

  // Sequences: only a FLAT list (all items scalar) is editable as chips.
  if (isSeq(value)) {
    const seq = value;
    const allScalar = seq.items.every((it) => isScalar(it) || it === null);
    if (allScalar) {
      const list = seq.items.map((it) =>
        it === null ? '' : isScalar(it) ? String((it as Scalar).value) : '',
      );
      return { key, kind: 'list', list };
    }
  }

  // Everything else (nested map, non-flat seq, etc.) -> complex, preserved
  // verbatim. Capture the exact source span of the value.
  const raw = rangeText(value, yamlSrc);
  return { key, kind: 'complex', raw };
}

/**
 * The string form of a mapping key, or `null` for non-scalar keys (which a flat
 * frontmatter model never has at top level). Narrows via the `yaml` type guard
 * so we only read `.value` from an actual Scalar.
 */
function scalarKeyString(keyNode: unknown): string | null {
  return isScalar(keyNode) ? String(keyNode.value) : null;
}

/** Extract the verbatim source text covered by a node's range. */
function rangeText(node: unknown, yamlSrc: string): string {
  const range = (node as { range?: [number, number, number] }).range;
  if (range) return yamlSrc.slice(range[0], range[1]);
  return '';
}

/**
 * Re-serialize a list of Properties into a complete frontmatter block, INCLUDING
 * the `---` fences and the trailing newline after the closing fence. Returns the
 * empty string when there are no properties, so a Concept with no frontmatter
 * emits no block at all (and deleting the last property drops the block).
 *
 * Scalars and flat lists are serialized from their structured form; `complex`
 * entries are re-emitted verbatim from their captured `entry` source (ADR 0003).
 * Properties are emitted in array order, so document order is preserved.
 */
export function serializeFrontmatter(props: Property[]): string {
  if (props.length === 0) return '';
  let yaml = '';
  for (const p of props) {
    // Skip not-yet-named rows. A freshly added property (slice: add Text/List)
    // lives in the structured state with an empty key until the user commits a
    // name; emitting `"":` would write a stray/duplicate empty key to disk on
    // the autosave that follows the add. Omitting it keeps disk clean until the
    // key is committed; a discarded row then leaves no trace.
    if (p.key === '') continue;
    if (p.kind === 'complex') {
      let e = p.entry ?? '';
      if (e !== '' && !e.endsWith('\n')) e += '\n';
      yaml += e;
      continue;
    }
    const key = serializeKey(p.key);
    if (p.kind === 'list') {
      yaml += `${key}: ${serializeList(p.list ?? [])}\n`;
    } else {
      const v = p.scalar ?? '';
      // Empty scalar -> bare `key:` (matches the new-Concept scaffold and reads
      // cleaner than `key: ''`); both parse back to an empty/flagged value.
      yaml +=
        v === ''
          ? `${key}:\n`
          : `${key}: ${serializeScalar(v, p.boolean ?? false, p.number ?? false)}\n`;
    }
  }
  // All properties were unnamed (e.g. a single just-added, not-yet-committed
  // row): emit no block rather than an empty `---\n---`.
  if (yaml === '') return '';
  return `---\n${yaml}---\n`;
}

/**
 * Return a copy of `prop` with its key changed to `newKey`.
 *
 * For `scalar`/`list` the serializer emits the key from `prop.key`, so changing
 * the field is enough. For `complex` the serializer re-emits the verbatim
 * `entry` source — which embeds the OLD key in its first line — so we must
 * rebuild `entry` with the new key while preserving the value text byte-for-byte
 * (ADR 0003). We splice only the key portion of the first line (everything up to
 * and including the first `:`), leaving the value and any following block lines
 * untouched. If the entry shape is unexpected (no `:` on the first line), we
 * clear `entry` and fall back to the structured/raw form so the rename still
 * applies without corrupting output.
 */
export function renameProperty(prop: Property, newKey: string): Property {
  if (prop.kind !== 'complex') {
    return { ...prop, key: newKey };
  }
  const entry = prop.entry ?? '';
  // Find the first `:` that terminates the key on the entry's first line.
  const nl = entry.indexOf('\n');
  const firstLineEnd = nl === -1 ? entry.length : nl;
  const colon = entry.indexOf(':');
  if (colon === -1 || colon > firstLineEnd) {
    // No usable key separator — drop the verbatim entry and let the serializer
    // re-emit from `raw` instead (degrades gracefully; value still preserved).
    const value = prop.raw ?? '';
    const rebuilt = `${serializeKey(newKey)}: ${value}`.replace(/\n*$/, '\n');
    return { ...prop, key: newKey, entry: rebuilt };
  }
  // Replace the key text (everything before the colon) with the new key,
  // keeping the colon and the rest of the entry (value + block lines) verbatim.
  const rest = entry.slice(colon); // starts at `:`
  return { ...prop, key: newKey, entry: `${serializeKey(newKey)}${rest}` };
}

/**
 * Recombine structured frontmatter with a body into the full Concept markdown.
 * The inverse of splitting a Concept into `parseProperties` + `splitFrontmatter`
 * `body`. With no properties this is just the body (no frontmatter block).
 */
export function joinConcept(props: Property[], body: string): string {
  return serializeFrontmatter(props) + body;
}

/** Serialize a mapping key (quote only when needed). */
function serializeKey(key: string): string {
  return needsQuoting(key) ? JSON.stringify(key) : key;
}

/**
 * Serialize a scalar value the way YAML would, but minimally — we want clean
 * output without disturbing surrounding text. Quote only when necessary.
 */
function serializeScalar(value: string, asBoolean: boolean, asNumber = false): string {
  if (asBoolean) {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === 'false') return v;
    // No longer a boolean -> fall through to string handling.
  }
  if (asNumber) {
    // Preserve the original numeric type: emit unquoted while the value still
    // parses as a number. If the user edited it to something non-numeric, fall
    // through to string handling (which will quote as needed).
    const v = value.trim();
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return v;
  }
  if (value === '') return "''";
  if (needsQuoting(value)) {
    // Use double quotes with minimal escaping.
    return JSON.stringify(value);
  }
  return value;
}

/** Whether a plain scalar string needs quoting to stay an unambiguous string. */
function needsQuoting(value: string): boolean {
  if (value !== value.trim()) return true; // leading/trailing space
  // YAML special starts and indicators.
  if (/^[!&*?|>%@`"'#,\[\]{}]/.test(value)) return true;
  if (/[:#]\s|\s#|: |^- /.test(value)) return true;
  if (/[\n\r\t]/.test(value)) return true;
  // Tokens that YAML would interpret as non-string.
  const lower = value.toLowerCase();
  if (
    ['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~', ''].includes(lower)
  ) {
    return true;
  }
  // Looks like a number.
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) return true;
  return false;
}

/** Serialize a flat list as a YAML flow sequence: `[a, b, c]` (or `[]`). */
function serializeList(items: string[]): string {
  if (items.length === 0) return '[]';
  return '[' + items.map((it) => serializeScalar(it, false)).join(', ') + ']';
}

/**
 * Humanize a `.md` filename into a `title` (slice: new-concept-scaffolding).
 * Strips the extension, replaces `-`/`_` separators with spaces, collapses
 * whitespace, and sentence-cases the result (e.g. `my-note.md` → "My note").
 */
export function titleFromFilename(filename: string): string {
  const stem = stripMd(basename(filename));
  const words = stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (words === '') return '';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Compose a spec-valid frontmatter STUB for a brand-new Concept: an empty
 * required `type` field (where the user lands first) and a `title` derived from
 * the filename. The file is immediately OKF-valid once `type` is filled.
 */
export function scaffoldConcept(filename: string): string {
  const title = titleFromFilename(filename);
  return `---\ntype:\ntitle: ${serializeScalar(title, false)}\n---\n\n`;
}
