// The contract a Frontmatter key FAMILY implements to plug into the OKF
// language service's completion (ADR 0009, ov-3).
//
// The completion engine (`./complete.ts`) knows nothing about any one family:
// it walks `OKF_FAMILIES` (`./families/index.ts`) and asks each for its
// completions. A family adds behaviour by editing ITS OWN module under
// `./families/` — never a switch in the service.
//
// The lint rules for the same families live in Rust
// (`sunstone_shared::okf_lint`, reached through `./lint.ts`), so the editor and
// `sunstone lint` agree; completion stays here because it works on a
// half-typed block by indentation, not on a parse.

/**
 * A path into the Frontmatter: map keys, with `'*'` standing for every item of
 * a list. `[]` is the top level; `['sources', '*']` is each `sources` entry.
 */
export type Path = readonly string[];

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

/** A Frontmatter key family plugged into completion. */
export interface OkfFamily {
  /** Stable id, matching the `source` of its lint findings. */
  id: string;
  /** Keys and values this family offers to complete. */
  completions?: readonly CompletionSpec[];
}
