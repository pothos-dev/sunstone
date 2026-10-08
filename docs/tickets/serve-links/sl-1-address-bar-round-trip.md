---
status: captured
---

# sl-1: The address bar URL does not always reload the same Concept

**What to build:** under `sunstone serve`, any URL the address bar shows reloads
the same Concept, at the same anchor where the URL had one. The 2026-10-08
nightly review of 59ccaa5 found three cases that break:

- A Concept with a dot in its last segment (`release-1.2.md`, `v1.0/index.md`)
  gets the pretty URL `/release-1.2` or `/v1.0`. The server's `is_spa_route`
  (`crates/sunstone-server/src/local.rs`) reads `2` / `0` as a file extension
  and answers 404 on reload.
- A leaf that shares its name with a folder (`guide.md` next to
  `guide/index.md`) gets `/guide`, which resolves to `guide/index.md`, so a
  reload opens the other Concept.
- Opening `/guide/topic.md#topic` rewrites the URL to `/guide/topic` and drops
  the `#topic`, so a reload lands at the top. `tests/serve-deep-link.spec.ts`
  currently asserts the hash is dropped.
