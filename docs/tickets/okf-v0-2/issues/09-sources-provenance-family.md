---
status: ready-for-agent
blocked-by: [01, 02, 03]
---

# 09: Provenance family — `sources`, credibility signals, and per-claim attribution

**What to build:** a reader can see what a Concept was derived from, follow those sources where they are followable, and jump from a specific claim in the body to the source backing it. OKF v0.2 moves provenance out of the body and into Frontmatter as `sources`, a list of entries where only `resource` is required, plus optional `id`, `title` and the credibility signals `author`, `usage_count` and `last_modified`. A `usage_window` of `{ from, to }` sits as a sibling of `sources` and frames every `usage_count`, and a single entry may override it.

A `resource` is not always a link: it is an absolute URL, a bundle-relative path, a path into a `references/` subdirectory — or a population or scope descriptor like `all queries in BigQuery project X` that cannot be followed at all. Rendering must not turn the last kind into a broken link.

Per-claim attribution joins on `id`: the body cites with a markdown footnote whose label equals a `sources[].id`, and consumers resolve through the matching entry rather than parsing the footnote prose. Labels are keyed rather than positional precisely because agents reorder these lists.

This ticket also carries the v0.1 migration it supersedes: the body `# Citations` list becomes `sources`, and a consumer SHOULD read `sources` while MAY still parsing a legacy `# Citations` list.

- [ ] `sources` parses, renders and edits as a list of maps, with `resource` enforced as required within an entry
- [ ] `usage_window` is edited as a sibling of `sources`, and a per-entry override is respected when present
- [ ] A `resource` that is a URL or an in-Bundle path is followable; a scope descriptor renders as plain text and is never styled as a broken link
- [ ] A footnote whose label matches a `sources[].id` resolves to that entry, and reordering the list does not change what a claim attributes to
- [ ] Credibility signals render as the objective values they are — no credibility score is computed or stored
- [ ] A legacy `# Citations` body list still displays as provenance, and the recommended-keys vocabulary offers `sources`
- [ ] Unit tests cover entry parsing, the three `resource` kinds, footnote joining and the legacy fallback
- [ ] All four gates green
