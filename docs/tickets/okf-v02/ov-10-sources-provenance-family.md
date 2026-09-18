---
status: ready-for-agent
blocked-by: [ov-1, ov-2, ov-3, ov-4]
---

# ov-10: Provenance family — `sources`, credibility signals, and per-claim attribution

**What to build:** a reader can see what a Concept was derived from, follow those sources where they are followable, and jump from a specific claim in the body to the source backing it. OKF v0.2 moves provenance out of the body and into Frontmatter as `sources`, a list of entries where only `resource` is required, plus optional `id`, `title` and the credibility signals `author`, `usage_count` and `last_modified`. A `usage_window` of `{ from, to }` sits as a sibling of `sources` and frames every `usage_count`, and a single entry may override it.

A `resource` is not always a link: it is an absolute URL, a bundle-relative path, a path into a `references/` subdirectory — or a population or scope descriptor like `all queries in BigQuery project X` that cannot be followed at all. Rendering must not turn the last kind into a broken link.

Per-claim attribution joins on `id`: the body cites with a markdown footnote whose label equals a `sources[].id`, and consumers resolve through the matching entry rather than parsing the footnote prose. Labels are keyed rather than positional precisely because agents reorder these lists.

**Decision — adopt the sanctioned footnote syntax, deprecate `[n]`.** Sunstone's own per-claim convention today is a bare `[n]` superscript joining to a `[n] …` row in a body citation table. That is a bespoke form no other markdown renderer understands, and it is positional into the body — exactly the silent-misattribution failure §5.1 keys on `id` to avoid. Sunstone switches to the standard `[^label]` markdown footnote (PHP Markdown Extra / GFM / pandoc / Obsidian), with the label joining to a `sources[].id`. Reading is rendered by turning on comrak's `extension.footnotes` rather than by extending Sunstone's sentinel path; comrak emits the superscript, the footnote section and the back-references itself.

The `[n]` form is **deprecated, not removed**: `find_citation_refs` / `citation_def_pos` and the `citations` CodeMirror extension keep working so v0.1 Bundles still read correctly, alongside the legacy `# Citations` list. Nothing new should be authored in that form, and the docs must say so. `[n]` is digits-only, so it cannot collide with a `[^label]` footnote.

Editing `sources` itself is not this ticket's problem — the YAML Frontmatter editor is [ov-2](ov-2-frontmatter-yaml-editor.md) and its OKF lint/completion is [ov-3](ov-3-okf-language-service.md); this ticket consumes both, and contributes the `sources` rules to the second.

This ticket also carries the v0.1 migration it supersedes: the body `# Citations` list becomes `sources`, and a consumer SHOULD read `sources` while MAY still parsing a legacy `# Citations` list.

- [ ] `sources` parses, renders and edits as a list of maps, with `resource` enforced as required within an entry
- [ ] `usage_window` is edited as a sibling of `sources`, and a per-entry override is respected when present
- [ ] A `resource` that is a URL or an in-Bundle path is followable; a scope descriptor renders as plain text and is never styled as a broken link
- [ ] A `[^label]` footnote renders through comrak's `extension.footnotes`, and a label matching a `sources[].id` resolves to that entry — reordering the list does not change what a claim attributes to
- [ ] Credibility signals render as the objective values they are — no credibility score is computed or stored
- [ ] A legacy `# Citations` body list still displays as provenance, and the recommended-keys vocabulary offers `sources`
- [ ] The `[n]` superscript form still reads for v0.1 Bundles but is documented as deprecated everywhere it is described (`docs/okf/linking.md`, `docs/okf/concept.md`, `docs/editor/custom-extensions.md`, `docs/editor/atomic-editor-patch.md`)
- [ ] An ADR records the move to `[^label]` footnotes and the deprecated-not-removed posture of `[n]`, in the shape of ADR 0004's optional-secondary-form decision
- [ ] Unit tests cover entry parsing, the three `resource` kinds, footnote joining, and both legacy fallbacks (`# Citations`, `[n]`)
- [ ] All four gates green
