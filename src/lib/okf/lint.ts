// The OKF language service's lint half (ADR 0009): `lintFrontmatter`.
//
// The rules live in Rust (`sunstone_shared::okf_lint`) so the editor and
// `sunstone lint` report the same findings (ADR 0006); this is the editor's
// seam onto them over wasm. The Frontmatter editor runs it through
// `@codemirror/lint` (`editor/yamlLanguage`).
//
//   mode 'yaml' — well-formedness only: parse errors and duplicate keys. This
//                 is what every Bundle gets, OKF or not.
//   mode 'okf'  — the above, plus every OKF family the Concept opted into.
//                 Only a Bundle whose root `index.md` declares `okf_version`
//                 gets this (see `./mode.ts`).
//
// The save gate does NOT ask this (it asks `isParseable` in `$lib/frontmatter`),
// so whether a Concept saves can never drift with lint policy.

import { frontmatterFindings, type Finding } from '$lib/wasm/exports';

export type { Finding };

/** Which rules apply: well-formedness only, or well-formedness plus OKF. */
export type LintMode = 'yaml' | 'okf';

/**
 * Lint a Frontmatter block (the inner YAML, no `---` fences). Findings carry
 * UTF-16 offsets into `yaml` and are sorted by position.
 */
export function lintFrontmatter(yaml: string, mode: LintMode): Finding[] {
  return frontmatterFindings(yaml, mode === 'okf');
}
