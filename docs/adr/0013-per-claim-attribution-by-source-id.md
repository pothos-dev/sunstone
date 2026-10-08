# Per-claim attribution joins `[^id]` to `sources`; `[n]` stays, deprecated

OKF v0.2 moves provenance out of the body and into the `sources` Frontmatter list
([§5.1](/okf/spec.md#51-provenance-sources)), and attributes a claim with a markdown footnote
whose label is a `sources[].id`. Sunstone makes that the **primary** attribution form and
keeps v0.1's `[n]` superscripts into a body `# Citations` list as an **optional, secondary,
deprecated** form: read, never written, in the shape of
[ADR 0004](0004-wikilinks-optional-secondary-name-based.md)'s wikilinks beside markdown links.

The `[^id]` model:

- **The label is the join key.** A `[^id]` resolves through the `sources` entry with that id
  (case-insensitively; the first entry with a repeated id owns it). Consumers never parse the
  footnote prose, as §5.1 says.
- **No body definition is required.** A `[^id]` with a `sources` entry and no `[^id]: …` line is
  resolved, not broken; that is the normal case, and what `/llm-wiki` writes. A reference is
  broken only when its label matches neither a `sources` id nor a body definition. A definition
  written by another tool is tolerated: its line is hidden and its text shown on the Sources
  entry. A definition whose label has no `sources` entry is an ordinary footnote.
- **Sequential numbers, by first use.** A reference shows `1, 2, 3` in the order labels are first
  cited, never the id, and the id appears on hover. Numbering depends on the body alone, so
  reordering `sources` changes neither what a claim attributes to nor its number. Numeric
  labels (`[^21]`) are renumbered the same way.
- **A virtual Sources section.** The `sources` list renders after the body as a bibliography:
  cited entries by number, then uncited ones, each with its resource (followable or a plain-text
  scope descriptor), its credibility signals as written, and jumps back to the claims citing it.
  It exists only in the view, never in the file. Editing stays YAML, reached through Edit on an
  entry.

The legacy form:

- **`[n]` still reads.** An inline `[n]` that follows a word renders as a superscript jumping to
  the line-start `[n]` row (`find_citation_refs` / `citation_def_pos`, the `citations` CodeMirror
  extension, the native render's `citations.rs`), and a body `# Citations` list renders as the
  markdown it is. v0.1 Bundles keep working: the spec says consumers SHOULD read `sources` and MAY
  still parse a legacy `# Citations` list ([§13.1](/okf/spec.md#131-breaking-changes)).
- **Nothing new is authored in it.** Sunstone offers no affordance that writes `[n]` or
  `# Citations`, and every page that describes them says they are deprecated. The `/llm-wiki`
  skill's `migrate-footnotes.ts` converts an existing document.
- **Not removed.** Dropping `[n]` would break every v0.1 Bundle's citations for no gain; the two
  forms cannot collide (`[n]` needs no caret, `[^n]` needs one).

## Considered Options

- **`[^id]` joined to `sources`, numbered, virtual section (chosen)** — what §5.1 specifies, keyed
  rather than positional so it survives agents reordering the list, readable as numbers.
- **Show the id as the superscript** — faithful to the source text, but ids like `ga4-schema`
  make poor superscripts and push the line apart.
- **Require a body definition per footnote** (GFM's model) — non-OKF renderers (GitHub, Obsidian)
  would then show the footnote, but the definition duplicates `sources[].title`, drifts from it,
  and §5.1 asks for none.
- **comrak's footnote extension** — renumbers by its own rules, moves definitions to the end and
  knows nothing of `sources`; the editor and the render would disagree.
- **Remove `[n]`** — simpler code, but breaks v0.1 Bundles the spec says remain consumable.

## Consequences

- One shared reading of `sources` (`sunstone_shared::sources`: entries, resource kinds,
  `usage_window`, numbering, citing places, a body definition's text) feeds the editor over wasm
  and the native render directly ([ADR 0006](0006-wasm-shared-core-for-frontend-logic.md)).
- Renderers that do not know OKF show a definition-less `[^id]` literally. That is the cost of
  following §5.1.
- Two attribution forms live side by side, as two link models do under ADR 0004. A future reader
  who finds `citations.rs` should read it as the v0.1 compatibility path, not a second way to
  write.
