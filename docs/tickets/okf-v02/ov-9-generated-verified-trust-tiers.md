---
status: ready-for-agent
blocked-by: [ov-1, ov-2, ov-3, ov-4]
---

# ov-9: Trust family — `generated`, `verified`, and trust tiers

**What to build:** a reader can tell at a glance who wrote a Concept, who has confirmed it, and how recently — and an author can edit all of it as YAML. OKF v0.2 replaces the flat `timestamp` with `generated: { by, at }`, adds `verified` as a list of `{ by, at }` confirmation events, and defines three derived trust tiers: no `verified` key is unverified, `verified` by non-`human:` actors only is machine-confirmed, and any `human:` actor makes it human-reviewed. Tiers are derived, never stored.

Two consumer rules are mandatory, not stylistic. A bare `verified` mapping written without the list dash MUST be treated as a one-element list. And a Concept missing any of these keys MUST still be consumable — the absence carries meaning but is never an error.

This ticket also carries the v0.1 migration, because it owns the same field: `timestamp` is superseded by `generated.at`, and a consumer MAY fall back to a legacy `timestamp` when `generated` is absent.

- [ ] `generated` and `verified` parse and render, and both are authorable in the Frontmatter editor, including adding and removing verification events
- [ ] A bare `verified` mapping is normalised to a one-element list on read, and editing it does not corrupt a Concept that used the bare form
- [ ] `generated.by` is required within `generated`; a `generated` block missing it degrades visibly rather than being dropped
- [ ] Timestamps are ISO 8601 with an explicit UTC offset on write, and a value without one is displayed rather than rejected
- [ ] The derived trust tier is surfaced to the reader and recomputed from `verified` alone, never persisted
- [ ] A Concept carrying only a legacy `timestamp` displays it as the generation time, and completion offers `generated` rather than `timestamp` for new Concepts
- [ ] In an OKF Bundle, lint reports a `generated` block missing `by` as an error and a non-ISO `at` as a warning; in a non-OKF Bundle it says nothing ([ov-3](ov-3-okf-language-service.md))
- [ ] A Concept with none of these keys renders normally with no warning
- [ ] Unit tests cover tier derivation, bare-mapping normalisation and the legacy fallback
- [ ] All four gates green
