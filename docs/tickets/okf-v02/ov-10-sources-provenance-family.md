---
status: ready
blocked-by: [ov-1, ov-2, ov-3, ov-4, ov-14, ov-15]
---

# ov-10: Provenance family — `sources`, credibility signals, and per-claim attribution

**What to build:** a reader can see what a Concept was derived from, follow those sources where they are followable, and jump from a specific claim in the body to the source backing it. OKF v0.2 moves provenance out of the body and into Frontmatter as `sources`, a list of entries where only `resource` is required, plus optional `id`, `title` and the credibility signals `author`, `usage_count` and `last_modified`. A `usage_window` of `{ from, to }` sits as a sibling of `sources` and frames every `usage_count`, and a single entry may override it.

A `resource` is not always a link: it is an absolute URL, a bundle-relative path, a path into a `references/` subdirectory — or a population or scope descriptor like `all queries in BigQuery project X` that cannot be followed at all. Rendering must not turn the last kind into a broken link.

Per-claim attribution joins on `id`: the body cites with `[^id]`, and consumers resolve through the matching `sources` entry rather than parsing any footnote prose (§5.1). Labels are keyed rather than positional precisely because agents reorder these lists. [ov-14](ov-14-footnote-detection-and-rendering.md) already detects and renders `[^label]` footnotes in the body; this ticket joins them to `sources`.

**The reader never sees `sources` as YAML.** The Frontmatter stays the store, but a Concept with 20 sources would otherwise put a screen of YAML in front of the body. Sunstone renders the list as a **Sources section**, a virtual block at the end of the document (not written to the file), like a paper's bibliography:

- One entry per `sources` item, numbered in order of first citation in the body; uncited entries follow, unnumbered, in list order.
- Each entry shows `title` (or `resource` when there is no title), the `resource` as a link when it is followable and as plain text when it is a scope descriptor, and the credibility signals as the values they are. No credibility score is computed or stored.
- Each entry lists the places in the body that cite it, each a jump back to that claim.
- An **Edit** action on an entry expands the Frontmatter Region, unfolds that entry (see [ov-15](ov-15-fold-frontmatter-blocks.md)) and puts the caret on it. Editing is YAML only; there is no form.

**Citations in the body:**

- A `[^id]` renders as a superscript with its **sequential number** (1, 2, 3 by first use), not the id. Hover shows the id, `title` and `resource`; a click jumps to the entry in the Sources section.
- A `[^id]` matching a `sources[].id` is resolved even with **no** footnote definition in the body; that is the normal case. It is broken only when it matches neither a `sources` id nor a body definition.
- A `[^id]: …` definition in the body is optional. When one exists for a label that has a `sources` entry, the editor hides the definition line in hybrid and reading mode and shows its text in the Sources entry instead. A definition with no `sources` entry keeps ov-14's behaviour.
- A numeric `[^n]` with no `sources` entry (migrated v0.1 documents) keeps ov-14's behaviour: label as written, jump to its body definition.

**Legacy forms, deprecated but still read:** the `[n]` superscript form (`find_citation_refs` / `citation_def_pos` and the `citations` CodeMirror extension) and the body `# Citations` list. Nothing new should be authored in either, and the docs must say so. A consumer SHOULD read `sources` while MAY still parse a legacy `# Citations` list.

Editing `sources` itself is not this ticket's problem — the YAML Frontmatter editor is [ov-2](ov-2-frontmatter-yaml-editor.md) and its OKF lint/completion is [ov-3](ov-3-okf-language-service.md); this ticket consumes both, and contributes the `sources` rules to the second.

- [ ] `sources` parses as a list of maps, with `resource` enforced as required within an entry (an ov-3 rule)
- [ ] `usage_window` is read as a sibling of `sources`, and a per-entry override is respected when present
- [ ] The Sources section renders at the end of the document in the editor (hybrid + reading) and in the web viewer, and is never written to the file
- [ ] A `resource` that is a URL or an in-Bundle path is followable; a scope descriptor renders as plain text and is never styled as a broken link
- [ ] Credibility signals render as the objective values they are
- [ ] `[^id]` renders as a sequential number by first use; reordering `sources` does not change what a claim attributes to or how it is numbered
- [ ] Hover on a citation shows id, title and resource; click jumps to the Sources entry; each entry jumps back to its citing claims
- [ ] A `[^id]` with a `sources` entry and no body definition is resolved, not broken
- [ ] A body definition for a `sources` id is hidden and its text shown on the entry
- [ ] Edit on an entry opens the Frontmatter with that entry unfolded and the caret on it
- [ ] A legacy `# Citations` body list still displays, and the recommended-keys vocabulary offers `sources`
- [ ] The `[n]` superscript form still reads for v0.1 Bundles but is documented as deprecated everywhere it is described (`docs/okf/linking.md`, `docs/okf/concept.md`, `docs/editor/custom-extensions.md`, `docs/editor/atomic-editor-patch.md`)
- [ ] An ADR records the `[^id]` attribution model (no body definition required, sequential numbering, virtual Sources section) and the deprecated-not-removed posture of `[n]`, in the shape of ADR 0004's optional-secondary-form decision
- [ ] Unit tests cover entry parsing, the three `resource` kinds, id joining and numbering, and both legacy fallbacks (`# Citations`, `[n]`)
- [ ] All four gates green

## Decisions

- Sources render as a virtual section at the end of the document, not in the Frontmatter Region and not in the Sidebar. It is where a reader expects a bibliography, and the jump target stays close to the text.
- Citations number sequentially by first use, with the id on hover. Ids like `ga4-schema` make poor superscripts.
- No footnote definition in the body. §5.1 makes the label the join key and lets consumers ignore the footnote prose; no sentence requires the definition, and the title already lives in `sources[].title`. The `/llm-wiki` skill writes none and lints against them. Sunstone still tolerates and hides one written by another tool. Cost: renderers that do not know OKF (GitHub, Obsidian) show `[^id]` literally.
- Editing stays YAML, reached through Edit on an entry. A form would have to rewrite YAML while preserving comments, which ADR 0008 keeps us from doing cheaply.
- Not comrak's `extension.footnotes`, as originally planned here: it renumbers by its own rules, moves definitions to the end and knows nothing of `sources`. Rendering goes through the shared scanner and sentinel pass from ov-14, extended with the `sources` join.
