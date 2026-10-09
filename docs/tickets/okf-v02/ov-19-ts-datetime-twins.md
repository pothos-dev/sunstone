---
status: captured
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
  orders with `Date.parse`. It accepts `+0200` and rejects a lowercase `t`;
  Rust does the opposite.
- `lifecycle.ts` `lifecycleFromYaml` reads the lifecycle keys with the `yaml`
  package for the Tile header; the Explorer reads them through Rust
  `parseFrontmatter`.

- [ ] An `epochSeconds` wasm export; `parseInstant`, the provenance regex and its `Date.parse` ordering go
- [ ] `isStale` agrees with `isIsoDatetime` on every form Rust accepts (test in `lifecycle.test.ts`)
