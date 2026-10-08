---
status: decide
priority: 2
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

- [ ] `release-1.2.md` and `v1.0/index.md` reload from the address bar without a 404
- [ ] With `guide.md` and `guide/index.md` both present, `guide.md` active, a reload reopens `guide.md`
- [ ] `/guide/topic.md#topic` keeps `#topic` after the URL is rewritten; navigating to another Concept drops it
- [ ] Unit tests on the pure helper, a `tests/serve-deep-link.spec.ts` case per bullet; all four gates green

## Grounding

- The address bar is written by a `$effect` in `src/lib/App.svelte` (after the
  last-open-Concept effect): `conceptHref(editor.path)` (`src/lib/web/urlSync.ts`,
  over wasm `conceptToUrl` = `sunstone_shared::url::concept_url`), replaced
  only when it differs from `location.pathname`. The hash is never carried.
- Reading the URL back is `startupFromUrl` in `src/lib/ipc/servedStartup.ts`,
  called from `takeStartupDocument` in `src/lib/ipc/http.ts`. A path ending in
  `.md` is matched literally against the Concept paths; anything else goes
  through `url_to_concept`, which prefers `<p>/index.md` over `<p>.md`
  (`url_to_concept_prefers_folder_index_over_leaf` in `url.rs`). So the Bundle
  path form (`/guide.md`) always round-trips; the pretty form does not when
  shadowed.
- The server side is `app_shell` / `is_spa_route` in
  `crates/sunstone-server/src/local.rs`: a missing path whose last segment has
  no dot, or ends in `.md`, gets the SPA shell; any other dotted path is a 404
  (ADR 0012: "Other missing files still 404", so a missing asset is not
  answered with HTML). `app_shell` only sees the built assets, not the Bundle.
- The pure helper belongs beside `startupFromUrl` in `servedStartup.ts`
  (AGENTS.md: pure logic in plain `.ts`). The effect can ask `indexStore`
  (`state/index.svelte.ts`, `exists`) whether `<p>/index.md` exists.
- Sunstone Web has the shadowing problem too (`conceptToUrl` in rendered links),
  but its SvelteKit route catches every path, so dotted names work there. Out
  of scope per the effort README.

## Open questions

1. **Dotted names: fix on the server or in the URL?**
   (a) The effect writes the Bundle path form (`/release-1.2.md`) whenever the
   last segment of the pretty URL contains a dot. No server change; the URL is
   less pretty for those Concepts only.
   (b) `app_shell` also serves the SPA for a dotted path when `<rel>.md` or
   `<rel>/index.md` is a Concept in the Bundle. Keeps pretty URLs, but the
   app-shell router has to reach the Bundle index.
   Recommendation: (a). It reuses the shadowing fix below, keeps the
   asset-404 rule untouched and stays client-side.

## Decisions

- Shadowed leaf → write the Bundle path form (`/guide.md`) when the pretty URL
  resolves to a different Concept. It is the only spelling that names the leaf.
- Anchor → when the effect rewrites the URL for the Concept the page URL
  already named (the `.md` → pretty rewrite at startup), keep `location.hash`.
  Navigating to another Concept drops it. Tracking the scrolled-to heading
  live is not asked for.
