---
status: active
priority: 2
---

# ov-19: Datetime parsing still has TS twins that disagree with Rust

**What to build:** every datetime check and comparison in the frontend goes
through the shared Rust (`trust::is_iso_datetime` / `epoch_seconds`) over wasm,
so lint, staleness and ordering agree.

The 2026-10-09 nightly review found:

- `src/lib/instant.ts` `parseInstant` re-implements `epoch_seconds`, and
  `lifecycle.ts` `isStale` uses it. Rust accepts `stale_after:
  2026-01-01T00:00:00+02`, a comma fraction (`…00,5Z`) and a leap second
  (`…23:59:60Z`); `parseInstant` returns null for all three. Lint stays silent,
  but the Concept is never marked stale.
- `src/lib/okf/families/provenance.ts` has its own `ISO_DATETIME` regex and
  orders with `Date.parse`. ~~It accepts `+0200` and rejects a lowercase `t`;
  Rust does the opposite.~~ Corrected while grounding: both accept `+0200`.
  The regex rejects a lowercase `t`, `+02` and a comma fraction, all of which
  Rust accepts, and it accepts impossible values (`2026-02-30`, hour `25`)
  that Rust rejects.
- `lifecycle.ts` `lifecycleFromYaml` reads the lifecycle keys with the `yaml`
  package for the Tile header; the Explorer reads them through Rust
  `parseFrontmatter`.

- [ ] An `epochSeconds` wasm export; `parseInstant`, the provenance regex and its `Date.parse` ordering go
- [ ] `isStale` agrees with `isIsoDatetime` on every form Rust accepts (test in `lifecycle.test.ts`)
- [ ] A second shared reader, `instant_seconds` (wasm `instantSeconds`), reads the forms ov-11 tolerates: the strict grammar with the offset optional (read as UTC) and a bare date (midnight UTC). `isStale`, `lifecycleView`'s "Stale after" line and the `stale_after` "no UTC offset" lint message use it, so `2026-09-23` and `2026-09-23T00:00:00` still go stale as `docs/okf/concept.md#lifecycle` documents
- [ ] Rust goldens (`cargo test`) for both readers: `+02`, `,5` fraction, `:60`, lowercase `t`/`z`, `±HHMM`, no offset, bare date, `2026-02-30`, hour 24, a space separator (rejected by both)
- [ ] Provenance `datetime()` uses `isIsoDatetime`; the `usage_window` `from` > `to` check compares `epochSeconds` and says nothing when either side is not ISO (`provenance.test.ts` cases: `+02` accepted, lowercase `t` accepted, `2026-02-30` warned, an inverted window with `+0200` offsets warned)
- [ ] `lifecycleFromYaml` reads through a wasm export over the same Rust reader the Explorer uses (`frontmatter::lifecycle_scalar`); it no longer imports `yaml`
- [ ] `src/lib/instant.ts` keeps only `isoUtc`; the `parseInstant` cases in `instant.test.ts` move into the Rust goldens; `lifecycle.test.ts` no longer imports `parseInstant`
- [ ] All four gates green, after `bun run build:wasm`

## Grounding

- Rust: `crates/sunstone-shared/src/trust.rs` `epoch_seconds` (line ~135) is
  the grammar: `YYYY-MM-DD`, `T`/`t`, `HH:MM`, optional `:SS` with a `.` or `,`
  fraction (the fraction is dropped, second resolution), then a required `Z`/`z`
  or `±HH`, `±HHMM`, `±HH:MM`. Calendar-checked, second ≤ 60.
  `is_iso_datetime` is `epoch_seconds(s).is_some()`. Goldens: `iso_datetimes`,
  `epoch_seconds_honours_the_offset`. Only `isIsoDatetime` crosses wasm
  (`crates/sunstone-wasm/src/lib.rs:336`, `src/lib/wasm/exports.ts:275`, which
  answers `true` before wasm loads).
- `src/lib/instant.ts` `parseInstant` accepts more than Rust (space separator,
  no offset, bare date, `+0200` without colon) and less (`+02`, `,` fraction,
  `:60`). Callers: `src/lib/lifecycle.ts` `isStale` and `lifecycleView`, and
  `src/lib/okf/families/lifecycle.ts` `staleAfterInstant`, which uses it to pick
  the "no UTC offset" message over "not ISO 8601". `isoUtc` (write form) is not
  a parser twin and stays; `trust.ts` and the lifecycle completion use it.
- The tolerated forms are shipped and documented behaviour, not an accident:
  ov-11 ("a value lacking one displays rather than errors") and
  `docs/okf/concept.md` line 88 plus the deviation table ("read as **UTC**").
  So strict `epoch_seconds` alone cannot replace `parseInstant` without
  dropping staleness for `2026-09-23`. Hence a second, lenient reader.
- `src/lib/okf/families/provenance.ts:41` `ISO_DATETIME` regex, used by
  `datetime()` for `usage_window.from/to` and `sources[].last_modified`;
  line 163 orders the window with `Date.parse`, which is engine-defined for
  non-ISO input. Rust reads the same keys as raw strings
  (`crates/sunstone-shared/src/sources.rs` `UsageWindow`) and never orders them.
- `lifecycleFromYaml` (`src/lib/lifecycle.ts:68`) is called once, by
  `src/lib/components/Tile.svelte:711`, with the inner YAML. The Explorer gets
  `TreeNode.status` / `staleAfter` from the walker
  (`crates/sunstone-native/src/bundle.rs:118`, `frontmatter.rs:271`
  `lifecycle_scalar`), and wasm `parseFrontmatter` returns the same two fields
  but takes the whole document, fences included.
- Tests to extend: `trust.rs` (or the new module) goldens,
  `src/lib/lifecycle.test.ts`, `src/lib/okf/families/lifecycle.test.ts`,
  `src/lib/okf/families/provenance.test.ts`; `tests/lifecycle.spec.ts` should
  keep passing unchanged. `bun test` preloads wasm, so the TS tests run the
  real Rust.

## Decisions

- Offset-less and date-only `stale_after` → still stale, read as UTC. ov-11 and
  `concept.md` ship and document this; the ticket is about agreement, not about
  narrowing what compares.
- How → a lenient Rust reader (`instant_seconds`) beside the strict one, not a
  flag on the TS side. The strict reader stays the lint and trust check; the
  lenient one is staleness only. One grammar, two entry points, no TS parsing.
- Space separator (`2026-09-23 10:30Z`) → not read by either. Rust never
  accepted it, the spec writes `T`, and today it gets the wrong lint message
  ("no UTC offset"). It becomes "not ISO 8601" and stops going stale.
- Home → move `epoch_seconds`, `is_iso_datetime` and the new reader into a
  `sunstone-shared/src/instant.rs`; `trust.rs` and `sources.rs` call it. It is
  no longer a trust-only concern once lifecycle and provenance use it.
- Pre-wasm fallback → `epochSeconds` / `instantSeconds` return `null`, so
  nothing is stale before wasm loads ("an unreadable date must not mark
  anything", `isStale`'s contract). `isIsoDatetime` keeps its `true` fallback.
- Fractional seconds → dropped, as Rust already does. Staleness at second
  resolution is fine for an advisory signal.
- Inverted `usage_window` with a non-ISO side → no ordering finding. The side
  already gets its own "should be ISO 8601" warning.
- `lifecycleFromYaml` → a yaml-taking wasm export (`lifecycleOf(yaml)`, like
  `trustOf(yaml)`) over `lifecycle_scalar`, rather than re-wrapping the YAML in
  fences to call `parseFrontmatter`.
