// Which lint mode the Frontmatter editor runs in (ADR 0009): the marker gate.

import { isReservedFile } from '$lib/reserved';
import type { LintMode } from './lint';

/**
 * `'okf'` only when the Bundle root declares `okf_version` (`okfVersion` is
 * non-null — `indexStore.okfVersion()`), the open file lies inside that root,
 * and it is a Concept rather than a reserved `index.md` / `log.md` (which carry
 * no `type`). Everything else gets `'yaml'`: well-formedness only. There is no
 * override and no heuristic.
 */
export function frontmatterLintMode(
  path: string | null,
  okfVersion: string | null,
  bundleRoot: string,
): LintMode {
  if (path === null || okfVersion === null) return 'yaml';
  if (bundleRoot !== '' && !path.startsWith(`${bundleRoot}/`)) return 'yaml';
  return isReservedFile(path) ? 'yaml' : 'okf';
}
