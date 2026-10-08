// The Frontmatter editor's lint mode (ADR 0009): `'okf'` in a Bundle that
// declares `okf_version`, else `'yaml'`. Held in editor state so the lazily
// loaded linter and completion source (`./yamlLanguage`) can read it, and so a
// mode change is a transaction the linter's `needsRefresh` can see — the lint
// re-runs when the Bundle's marker comes or goes, without the YAML changing.
//
// Its own module so `frontmatterEditor.ts` (eager) and `yamlLanguage.ts` (lazy)
// share it without either importing the other.

import { StateEffect, StateField } from '@codemirror/state';
import type { LintMode } from '$lib/okf/lint';

/** Switch the lint mode (dispatched by `FrontmatterEditor.setMode`). */
export const setLintMode = StateEffect.define<LintMode>();

/** The current lint mode; seeded by `lintModeField.init(() => mode)`. */
export const lintModeField = StateField.define<LintMode>({
  create: () => 'yaml',
  update(mode, tr) {
    for (const e of tr.effects) if (e.is(setLintMode)) mode = e.value;
    return mode;
  },
});
