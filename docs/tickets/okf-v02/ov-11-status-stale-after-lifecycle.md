---
status: ready-for-agent
blocked-by: [ov-1, ov-2, ov-3]
---

# ov-11: Lifecycle family — `status` and `stale_after`

**What to build:** a reader can tell whether a Concept is current before trusting it. OKF v0.2 adds two optional lifecycle keys: `status`, the Concept's place in its own lifecycle, and `stale_after`, an ISO 8601 datetime past which the content should be treated as out of date. Staleness is derived by comparing `stale_after` to now, not stored, and a Concept past its date is still fully consumable — the signal is advisory, never a gate.

Both are scalars, so this ticket is smaller than the other family tickets; it needs the Frontmatter editor only as the surface they are authored in, not for the values themselves.

- [ ] `status` and `stale_after` parse, render, and are authorable in the Frontmatter editor
- [ ] In an OKF Bundle, lint reports a `status` outside `draft | stable | deprecated` as an error and completion offers the three values; in a non-OKF Bundle it says nothing ([ov-3](ov-3-okf-language-service.md))
- [ ] A Concept past its `stale_after` is visibly marked stale wherever a Concept is summarised, and remains fully readable and editable
- [ ] Staleness is derived at display time from `stale_after` alone and never written back
- [ ] `stale_after` writes as ISO 8601 with an explicit UTC offset; a value lacking one displays rather than errors
- [ ] A Concept with neither key shows no lifecycle affordance at all
- [ ] Unit tests cover the staleness boundary, including a value exactly at now and a malformed date
- [ ] All four gates green
