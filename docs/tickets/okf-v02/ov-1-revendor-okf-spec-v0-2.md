---
status: resolved
---

# ov-1: Re-vendor the OKF spec at v0.2 and record its new upstream home

**What to build:** the vendored spec Sunstone reads from is the current one. Today it is a v0.1 snapshot captured 2026-06-17 from `GoogleCloudPlatform/knowledge-catalog`, and that path is now a frozen copy — the canonical spec has moved to `GoogleCloudPlatform/open-knowledge-format` and advanced to v0.2. Every doc that cites a spec section must still land on the right section after the renumbering, so a reader following a link from the Glossary or a Bundle/Concept page arrives where they expect.

The renumbering is the substance of this ticket, not the file swap. v0.2 inserts a new §5 (provenance/trust/lifecycle) and pushes everything after it down: Cross-linking §5 → §6, Index files §6 → §8, Log files §7 → §9, Conformance §9 → §11, Versioning §11 → §12. Every deep anchor link across the Bundle points at the old numbers.

- [x] `docs/okf/spec.md` is a verbatim copy of OKF v0.2, with its provenance block naming `GoogleCloudPlatform/open-knowledge-format` as canonical, a fresh capture date, and `Version captured: 0.2`
- [x] The provenance block notes that the `okf/` directory in `knowledge-catalog` is a frozen v0.1-era snapshot and must not be re-fetched from
- [x] Every `#section-anchor` link into the spec from elsewhere in the Bundle resolves to the intended section under v0.2 numbering — no broken or silently-wrong anchors
- [x] The spec deviation tables in the Bundle and Concept pages cite v0.2 section numbers
- [x] The Bundle page's description of root detection names the crate that actually implements it today, not the pre-ADR-0006 frontend module it currently cites
- [x] All four gates green
