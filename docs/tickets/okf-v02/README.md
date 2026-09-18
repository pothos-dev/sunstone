# OKF v0.2

Bring Sunstone up to OKF v0.2. The vendored spec was a v0.1 snapshot from
`GoogleCloudPlatform/knowledge-catalog`; the canonical spec has since moved to
`GoogleCloudPlatform/open-knowledge-format` and advanced to v0.2, which adds a
provenance/trust/lifecycle section (§5), an actor convention (§7), an
`okf_version` Bundle-root marker (§12), and one new Concept type (§10).

Three decisions bind every ticket here:

- **The vendored spec is the source of truth.** `docs/okf/spec.md` is a verbatim
  copy; nothing in this effort edits it. Where Sunstone departs from the spec,
  the departure is recorded in the deviation tables in
  [`docs/okf/bundle.md`](/okf/bundle.md) and [`docs/okf/concept.md`](/okf/concept.md),
  citing v0.2 section numbers.
- **New Frontmatter keys are optional everywhere.** A Concept missing any v0.2
  key MUST still be consumable. Absence carries meaning; it is never an error.
  Where v0.1 had an equivalent (`timestamp`, the body `# Citations` list), the
  ticket that owns the new key also carries the migration.
- **OKF behaviour is gated on the marker.** Linting and completion only apply in
  a Bundle that declares `okf_version`. `sunstone ./notes` must stay usable on a
  plain folder of markdown.

The dependency shape is a spine, not a chain: `ov-1` (spec) and `ov-2`
(Frontmatter editor) are done; `ov-4` (actors) and `ov-5` (marker) unblock
everything else. The family tickets — trust, provenance, lifecycle — each
contribute their own rules to the language service rather than owning it.

Out of scope: executing or verifying an Attested Computation. v0.2 defers the
runtime protocol, the receipt and verdict wire formats, and the attester ABI, so
Sunstone models and displays the contract and stops there.
