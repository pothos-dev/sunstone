---
status: done
blocked-by: [ov-1]
---

# ov-5: Trust the `okf_version` marker when finding the Bundle root

**What to build:** when a Bundle ships the one marker OKF actually sanctions, Sunstone believes it instead of guessing. v0.2 §12 permits `okf_version` in a bundle-root `index.md` frontmatter block and states it is the only place Frontmatter is permitted in a Reserved file — which makes an `index.md` carrying `okf_version` a positive, unambiguous root declaration. Sunstone's current root finder is deliberately structural: it infers from the path list alone and never reads Frontmatter, so it cannot see this marker and will still guess wrong on a Bundle that declares itself.

The seam is the interesting part. Root-finding is pure logic shared across the desktop backend, the web renderer and the Playwright fake, so the marker has to reach it as data — the finder must not grow IO. Feed it the parsed `okf_version` for candidate `index.md` files alongside the path list.

Treat the marker as a strong hint, not proof of absence: upstream issue #26 reports the reference agent's index regeneration silently dropping `okf_version`, so its absence must fall through to the existing heuristics rather than concluding there is no Bundle.

- [x] A directory whose `index.md` Frontmatter declares `okf_version` is chosen as the Bundle root, overriding every structural heuristic
- [x] When several ancestors declare it, the outermost wins — an inner declaration is treated as a nested Bundle, not the root
- [x] A missing or unparseable `okf_version` falls through to today's structural rules with no behaviour change
- [x] The root finder stays pure: no filesystem access added to the shared logic, and the desktop, web and fake backends agree
- [x] Unit tests cover marker-present, marker-absent, nested-markers and malformed-Frontmatter cases
- [x] The Bundle page documents the marker as the first rung of root detection
- [x] All four gates green

## Resolution

The finder moved to `crates/sunstone-shared/src/bundle_root.rs`:
`find_bundle_root(paths, markers) -> BundleRoot { dir, okf_version }`, with the
rungs `marker_root` and `structural_root` as separate public functions (ov-6 adds
its rungs here). Markers are `OkfMarker { indexPath, okfVersion }` data, parsed
by `frontmatter::okf_version_of` and served as `Backend.listOkfMarkers()`
(`list_okf_markers` / `GET /_api/okf-markers` / the fake store). `indexStore`
builds `BundleIndex(paths, markers)`; `indexStore.okfVersion()` reports the
declared version, `null` when the root was inferred. That is the gate ov-3 reads.

One call the ticket left open: markers in unrelated sibling directories
(`notes/index.md` and `wiki/index.md` both declaring) are treated as ambiguous
and fall through to the structural rung, the same "don't guess" rule the
structural rung applies to sibling indexes.
