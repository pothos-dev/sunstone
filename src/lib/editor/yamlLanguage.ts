// The Frontmatter editor's LAZY slice: the YAML grammar, its highlighting, and
// the well-formedness linter (ADR 0008).
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
import { yamlError } from '$lib/frontmatter';
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
 * Diagnostics for the Frontmatter editor: WELL-FORMEDNESS ONLY.
 *
 * OKF rules (required keys, enum values, duplicate keys) are the marker-gated
 * language service — they belong to a bundle that declares `okf_version`
 * (ADR 0009) and are layered on top of this, never folded into it. Keeping the
 * split here is what lets the save gate ask the SAME question this asks
 * (`yamlError`) without lint policy ever being able to hold a write back.
 */
function wellFormednessLinter(): Extension {
  return linter(
    (view) => {
      const doc = view.state.doc;
      const err = yamlError(doc.toString());
      if (err === null) return [];
      const from = Math.min(err.from, doc.length);
      const to = Math.min(Math.max(err.to, from), doc.length);
      const diagnostic: Diagnostic = {
        from,
        to,
        severity: 'error',
        source: 'yaml',
        message: err.message,
      };
      return [diagnostic];
    },
    { delay: PARSE_ERROR_DELAY_MS },
  );
}

/** The lazily-loaded language slice: grammar, highlighting, well-formedness lint. */
export function yamlSupport(): Extension[] {
  return [yamlLanguage(), syntaxHighlighting(yamlHighlight), wellFormednessLinter()];
}
