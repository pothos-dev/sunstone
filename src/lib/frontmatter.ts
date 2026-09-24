// Frontmatter as YAML TEXT (ADR 0008, superseding ADR 0003's `Property[]`).
//
// Sunstone no longer models frontmatter structurally. The YAML block IS the
// source of truth: it is edited as text in the Frontmatter Region's own
// CodeMirror and round-trips byte-for-byte, so unknown keys, comments, quoting
// style, key order and flow style all survive untouched (OKF §4.1 / §11).
//
// What is left in this module is the pure text plumbing around that block:
// recombining it with a body, asking whether it PARSES (the save gate, ADR 0008
// "The save gate"), reading a single field out of it (the Tile header title),
// and the explicit format command. Plus Concept scaffolding, which is unrelated
// to editing but has always lived here.
//
// Splitting a Concept into `open` / `yaml` / `close` / `body` is NOT here — it
// is `splitFrontmatter` in the shared Rust core (ADR 0006 §11-B).

import { parseDocument, stringify, type Document } from 'yaml';
import { basename, stripMd } from '$lib/path';

/**
 * The verbatim delimiter lines around a frontmatter block, carried alongside the
 * inner YAML so a body-only edit re-emits the file EXACTLY as it was read (a
 * `---\r\n` or `--- \n` opener survives). Sourced from `splitFrontmatter`.
 */
export interface Fences {
  /** Opening delimiter line incl. its trailing newline, e.g. `---\n`. */
  open: string;
  /** Closing delimiter line incl. its trailing newline. */
  close: string;
}

/** What a block gets when the Concept had no frontmatter to read fences from. */
export const DEFAULT_FENCES: Fences = { open: '---\n', close: '---\n' };

/**
 * Recombine a frontmatter block with a body into the full Concept markdown —
 * the inverse of `splitFrontmatter`. `yaml` is the INNER block (no fences), as
 * held by the Frontmatter editor.
 *
 * An empty or whitespace-only block emits NO fences at all (ADR 0008): clearing
 * the frontmatter removes it, the inverse of materialising the block on first
 * save. Otherwise the block is re-fenced with `fences`, defaulting to the
 * canonical `---\n` pair for a Concept that had none.
 */
export function joinConcept(yaml: string, body: string, fences: Fences = DEFAULT_FENCES): string {
  if (yaml.trim() === '') return body;
  const block = yaml.endsWith('\n') ? yaml : `${yaml}\n`;
  return fences.open + block + fences.close + body;
}

/** A YAML parse failure, with the document offsets to mark it at. */
export interface YamlError {
  message: string;
  /** Start offset within the YAML block. */
  from: number;
  /** End offset (always >= `from`; clamped into the block). */
  to: number;
}

/**
 * Parse `yaml` the one way every helper here does: `uniqueKeys: false`, so a
 * duplicate key is a lint finding rather than a parse error (see `yamlError`).
 * `parseDocument` collects errors on the document rather than throwing, but a
 * malformed input can still trip the tokenizer — that surfaces as `thrown`.
 */
function tryParseYaml(yaml: string): { ok: true; doc: Document } | { ok: false; thrown: unknown } {
  try {
    return { ok: true, doc: parseDocument(yaml, { uniqueKeys: false }) };
  } catch (e) {
    return { ok: false, thrown: e };
  }
}

/**
 * The first parse error in `yaml`, or `null` when the block is well-formed.
 * Drives BOTH the Frontmatter editor's error indicator and — via
 * `isParseable` — the save gate, so the two can never disagree about whether a
 * block is writable.
 *
 * Deliberately narrow: this is well-formedness only. OKF rules (required keys,
 * enum values, duplicate keys) are the marker-gated language service, ADR 0009 —
 * lint policy must never be able to hold a write back. `uniqueKeys: false` is
 * part of that narrowing: a duplicate key still yields a document (last wins),
 * so it is a LINT finding, not a reason to refuse the write.
 */
export function yamlError(yaml: string): YamlError | null {
  const parsed = tryParseYaml(yaml);
  if (!parsed.ok) {
    // A tokenizer throw is unparseable too.
    const e = parsed.thrown;
    return { message: e instanceof Error ? e.message : String(e), from: 0, to: yaml.length };
  }
  const first = parsed.doc.errors[0];
  if (!first) return null;
  const [from, to] = first.pos;
  const end = Math.min(Math.max(to, from + 1), Math.max(yaml.length, 1));
  return { message: first.message, from: Math.min(from, end), to: end };
}

/** Whether `yaml` is well-formed enough to write to disk (the save gate). */
export function isParseable(yaml: string): boolean {
  return yamlError(yaml) === null;
}

/**
 * The `title` scalar out of a frontmatter block, or `null` when there is none,
 * the block does not parse, or `title` is not a plain non-empty string. With the
 * structured model gone this is how anything that needs ONE field reads it
 * (ADR 0008): parse, tolerate failure, fall back.
 */
export function titleFromYaml(yaml: string): string | null {
  if (yaml.trim() === '') return null;
  const parsed = tryParseYaml(yaml);
  if (!parsed.ok) return null;
  let value;
  try {
    value = parsed.doc.toJS({ maxAliasCount: 100 }); // throws e.g. past maxAliasCount
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = (value as Record<string, unknown>).title;
  if (typeof title !== 'string') return null;
  const trimmed = title.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Reflow a frontmatter block: the EXPLICIT format command, never run on save
 * (ADR 0008). The `yaml` library preserves comments and quoting across a
 * parse/stringify round-trip but normalises whitespace, so running this on save
 * would reflow every file merely on being edited. Returns `null` when the block
 * does not parse (nothing to format) or when formatting would not change it.
 */
export function formatYaml(yaml: string): string | null {
  const parsed = tryParseYaml(yaml);
  if (!parsed.ok || parsed.doc.errors.length > 0) return null;
  const out = parsed.doc.toString().replace(/\n$/, '');
  return out === yaml ? null : out;
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
  return `---\ntype:\ntitle: ${stringify(title).trimEnd()}\n---\n\n`;
}
