---
status: done
blocked-by: [ov-1, ov-2, ov-3]
---

# ov-11: Lifecycle family — `status` and `stale_after`

**What to build:** a reader can tell whether a Concept is current before trusting it. OKF v0.2 adds two optional lifecycle keys: `status`, the Concept's place in its own lifecycle, and `stale_after`, an ISO 8601 datetime past which the content should be treated as out of date. Staleness is derived by comparing `stale_after` to now, not stored, and a Concept past its date is still fully consumable — the signal is advisory, never a gate.

Both are scalars, so this ticket is smaller than the other family tickets; it needs the Frontmatter editor only as the surface they are authored in, not for the values themselves.

- [x] `status` and `stale_after` parse, render, and are authorable in the Frontmatter editor
- [x] In an OKF Bundle, lint reports a `status` outside `draft | stable | deprecated` as an error and completion offers the three values; in a non-OKF Bundle it says nothing ([ov-3](ov-3-okf-language-service.md))
- [x] A Concept past its `stale_after` is visibly marked stale wherever a Concept is summarised, and remains fully readable and editable
- [x] Staleness is derived at display time from `stale_after` alone and never written back
- [x] `stale_after` writes as ISO 8601 with an explicit UTC offset; a value lacking one displays rather than errors
- [x] A Concept with neither key shows no lifecycle affordance at all
- [x] Unit tests cover the staleness boundary, including a value exactly at now and a malformed date
- [x] All four gates green

## Comments

- 2026-10-08: Shipped. Language service: `okf/families/lifecycle.ts` adds the `status` enum rule (error), a `stale_after` rule (warning when it is not ISO 8601 or lacks a UTC offset), and value completions (the three statuses; for `stale_after`, future UTC-midnight instants written with `Z`). Display: `src/lib/lifecycle.ts` (pure: `isStale`, `lifecycleView`, readers for YAML / rendered fields / tree nodes) over `src/lib/instant.ts` (strict ISO 8601 parse, offset-less read as UTC, `isoUtc` write form), rendered by `components/LifecycleBadge.svelte` in the Tile header, the web reader's concept strip, and Explorer rows (desktop and web; `stable` left out there). The walker carries the raw keys (`TreeNode.status` / `staleAfter`, via `ParsedFrontmatter`) so rows can be marked without opening the Concept; staleness is derived in the browser against a minute-ticking clock. Choices made here: the chips are not gated on `okf_version` (only lint and completion are), since they appear only for the spec's exact values; an unrecognised `status` and a malformed or future `stale_after` show nothing in summaries. Documented in [Concept → Lifecycle](/okf/concept.md#lifecycle). Note for whoever owns it: `tests/web-sources.spec.ts` was already failing on main before this change: it expects `Authorhuman:dan`, but the source card now renders the actor chip (`Authorpersondan`, ov-4).
