---
status: ready-for-agent
---

# 02: Edit nested Frontmatter in the Properties panel

**What to build:** an author can edit a Frontmatter value that is a map, or a list of maps, directly in the Properties panel instead of seeing it greyed out. Every OKF v0.2 family is nested — `generated` is a map, `verified` and `sources` are lists of maps — so without this every new family is read-only and the rest of this effort cannot deliver its editing criteria. This is a prefactor: land it before the family tickets.

Per-claim attribution depends on this too: [09](09-sources-provenance-family.md) moves citations from a body list to `[^label]` markdown footnotes whose label is a `sources[].id`, so authoring an attribution means editing a map inside a list — unreachable until this lands.

ADR-0003 holds Frontmatter as structured `Property[]` and re-serializes the whole block. Values it cannot model are classified `complex`, carry their original source text verbatim, and are rendered read-only. That classification is exactly what has to grow a real representation for two shapes: a map of scalars, and a list of maps of scalars. Anything more exotic stays `complex` and stays read-only — the goal is not a general YAML editor.

- [ ] A map-valued property renders its keys as editable rows; adding, renaming, deleting and reordering a key round-trips through the Bundle
- [ ] A list-of-maps property renders each entry as an editable group; adding and removing an entry round-trips
- [ ] A nested value the model still cannot represent remains `complex`, stays read-only, and survives edits to neighbouring properties byte-for-byte
- [ ] Re-serialization emits nested structures in a stable, diff-friendly shape, so an unedited Concept is not rewritten by merely opening it
- [ ] A new ADR supersedes or amends ADR-0003 to record the extended value model and what is still out of scope
- [ ] Unit tests cover the nested round-trip on the pure-logic side; a Playwright case covers editing a nested value in the panel
- [ ] All four gates green
