// The Frontmatter editor's LAZY slice: the YAML grammar, its highlighting, and
// the language service — lint and OKF completion (ADR 0008, ADR 0009).
//
// Everything in this module is behind a dynamic `import()` in
// `frontmatterEditor.ts`, so none of it — grammar, parser tables, lint panel —
// is fetched while the Frontmatter Region is collapsed, which is its default
// state. Same shape as `hydrateMermaid`: the surface renders first, the heavy
// language support lands a tick later.

import { yaml as yamlLanguage } from '@codemirror/lang-yaml';
import { linter, type Diagnostic } from '@codemirror/lint';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { lintFrontmatter } from '$lib/okf/lint';
import { completeFrontmatter } from '$lib/okf/complete';
import { lintModeField } from './lintModeField';
import { PARSE_ERROR_DELAY_MS } from './parseErrorDelay';

// The debounce is shared with the Region's own indicator; it lives in
// `./parseErrorDelay` so that module can be imported without pulling this
// (lazily loaded) grammar chunk in with it.

/**
 * YAML token colours, mapped onto the app's existing `--atomic-editor-hl-*`
 * variables so the Frontmatter editor picks up light/dark exactly like the body
 * editor does. `Literal` (a plain scalar) is deliberately unstyled — it inherits
 * the body colour, which keeps values quieter than keys.
 */
const yamlHighlight = HighlightStyle.define([
  { tag: t.definition(t.propertyName), color: 'var(--atomic-editor-hl-property)' },
  { tag: t.string, color: 'var(--atomic-editor-hl-string)' },
  { tag: t.special(t.string), color: 'var(--atomic-editor-hl-string)' },
  { tag: t.lineComment, color: 'var(--atomic-editor-hl-comment)', fontStyle: 'italic' },
  { tag: t.keyword, color: 'var(--atomic-editor-hl-keyword)' },
  { tag: t.meta, color: 'var(--atomic-editor-hl-comment)' },
  { tag: t.typeName, color: 'var(--atomic-editor-hl-type)' },
  { tag: t.labelName, color: 'var(--atomic-editor-hl-variable)' },
  { tag: t.attributeValue, color: 'var(--atomic-editor-hl-string)' },
  { tag: [t.separator, t.punctuation, t.squareBracket, t.brace], color: 'var(--atomic-editor-hl-operator)' },
]);

/**
 * Diagnostics for the Frontmatter editor: the language service's
 * `lintFrontmatter` (ADR 0009) in whatever mode the editor is in. Well-formedness
 * in every Bundle; OKF rules only in `'okf'` mode, i.e. when the Bundle root
 * declares `okf_version`.
 *
 * The save gate asks `isParseable`, never this, so lint policy can never hold a
 * write back. `needsRefresh` re-runs the lint when the mode flips (the marker
 * was added or removed) even though the YAML itself did not change.
 */
function frontmatterLinter(): Extension {
  return linter(
    (view) => {
      const doc = view.state.doc;
      return lintFrontmatter(doc.toString(), view.state.field(lintModeField)).map(
        (f): Diagnostic => ({
          from: Math.min(f.from, doc.length),
          to: Math.min(Math.max(f.to, f.from), doc.length),
          severity: f.severity,
          source: f.source,
          message: f.message,
        }),
      );
    },
    {
      delay: PARSE_ERROR_DELAY_MS,
      needsRefresh: (update) => update.startState.field(lintModeField) !== update.state.field(lintModeField),
    },
  );
}

/**
 * OKF key/value completion (ADR 0009), replacing the Properties panel's
 * `OKF_KEYS` suggestions. Silent outside `'okf'` mode. An empty key prefix only
 * completes on explicit request (Ctrl+Space) so a new line does not pop a list;
 * a value position (`status: `) completes as soon as there is something to offer.
 */
function okfCompletionSource(context: CompletionContext): CompletionResult | null {
  const mode = context.state.field(lintModeField);
  const found = completeFrontmatter(context.state.doc.toString(), context.pos, mode);
  if (!found) return null;
  if (found.kind === 'key' && found.prefix === '' && !context.explicit) return null;
  return {
    from: found.from,
    options: found.options.map((o) => ({
      label: o.label,
      detail: o.detail,
      info: o.info,
      apply: o.apply,
      type: found.kind === 'key' ? 'property' : 'constant',
    })),
    validFor: /^[\w.-]*$/,
  };
}

/** The lazily-loaded language slice: grammar, highlighting, lint, completion. */
export function yamlSupport(): Extension[] {
  return [
    yamlLanguage(),
    syntaxHighlighting(yamlHighlight),
    frontmatterLinter(),
    autocompletion({ override: [okfCompletionSource], icons: false }),
  ];
}
