---
status: ready
priority: 2
---

# ov-20: Native Backlinks resolve links without the Bundle root

**What to build:** Backlinks on desktop and web resolve bundle-absolute links
against the detected Bundle root, like the fake backend and the render already
do. (Captured as "detected (or user-set)"; corrected while grounding: the fake
does not use the override either, and ov-7 keeps the override on the frontend.
See Decisions.)

Found in the 2026-10-09 nightly review: `crates/sunstone-native/src/index/links.rs`
`extract_links` calls `resolve_location` with no root, so links resolve against
the opened folder. The fake's `outboundLinks` (`src/lib/ipc/fake/links.ts`)
resolves through `resolveLinkIn` with the markers. Example: `README.md`,
`docs/index.md` and `docs/a.md`, with `docs/b.md` linking `/a.md`. The fake
shows a backlink on `docs/a.md`; the desktop does not. ov-5 claimed desktop,
web and fake agree. `docs/okf/bundle.md` and the ov-7 ticket describe the old
behaviour wrongly as "resolves against the detected root". (Already corrected
in 50baa70: both now say it resolves against the opened folder and point here.)

- [ ] `Index` builds a `BundleRoot` and resolves links through it
- [ ] An `index.rs` test with a nested root and a bundle-absolute backlink
- [ ] `ConceptEntry` keeps the raw hrefs (like `wikilinks`); `rebuild_reverse` computes `find_bundle_root(concept_paths, okf_markers, git_prefix, None)` once per rebuild and resolves each href with `sunstone_shared::links::resolve_link` against the Concept set, the same call wasm `resolveLinkIn` makes
- [ ] A root that changes (an `index.md` gains or loses `okf_version`, a top-level `.md` appears) re-resolves every Concept's links on the next mutation, not only the edited one's (`index.rs` test: add the marker with `reindex_concept`, the backlink appears)
- [ ] A bundle-absolute link whose rooted target does not exist still falls back to the opened folder, as `apply_bundle_root` does (test)
- [ ] The git prefix reaches the index, so the git-toplevel rung anchors as it does in the frontend
- [ ] `docs/okf/bundle.md` (the "Only the frontend sees the override" paragraph) and ov-7's "Known limit" say Backlinks follow the detected root and only the override stays frontend-only
- [ ] All four gates green

## Grounding

- `crates/sunstone-native/src/index.rs`: `insert_concept` stores
  `links = extract_links(rel, content)`, already resolved per Concept;
  `rebuild_reverse` maps them through `folder_index_fallback` and resolves
  wikilinks by name against `all_paths`. Every mutation (`reindex_concept`,
  `apply_move`, `remove_concept`, `resync_folder`, `build`) ends in
  `rebuild_reverse`, so that is the one place with the whole path set and the
  markers (`Index::okf_markers`) in hand. Resolving at insert time cannot work:
  the root depends on every path.
- `extract_links` (`index/links.rs:39`) = `markdown_link_hrefs` +
  `paths::resolve_location`. It should return the raw hrefs (still skipping
  Embeds; the af-1 note stays). Its `resolves_relative_and_absolute_links` test
  changes with it.
- Shared resolver: `crates/sunstone-shared/src/links.rs` `resolve_link(current,
  href, root, exists)` handles external / anchor / empty links, rooting with
  the existence fallback, and `folder_index_fallback`. wasm `resolveLinkIn`
  (`crates/sunstone-wasm/src/lib.rs:384`) is `find_bundle_root(paths, markers,
  git_prefix, None)` + `resolve_link`, which is what the fake's `outboundLinks`
  runs. The fake passes no override.
- The override: `bundle_root.rs` `override_root` is rung 0, but only the
  frontend's wasm `BundleIndex` gets it (`src/lib/state/index.svelte.ts`
  `setRootOverride`). ov-7's Resolution: "It never reaches the server, so no
  route needed guarding"; `docs/okf/bundle.md` says the same.
- Git prefix: `AppState::git_prefix()` (`crates/sunstone-native/src/app_state.rs:51`)
  is a lazy `OnceLock` over `git::repo_prefix`; `Index` has none. The server
  boots (clone included) before `AppState::new` (`sunstone-server/src/lib.rs`
  lines 159 vs 213).
- Native web Backlinks go through the same `AppState.index`, so this fixes the
  desktop, `sunstone serve` and Sunstone Web at once.
- Existing tests to extend: `index.rs` `backlinks_via_wikilink`, the marker
  test near line 683 (already builds `docs/index.md` with `okf_version`),
  `index/links.rs` tests; `tests/backlinks-panel.spec.ts` runs on the fake and
  needs no change.

## Decisions

- The user's override → not in native Backlinks. ov-7 decided it is
  frontend-only View state that never crosses the server, and the fake
  (the parity reference here) ignores it too. Making Backlinks follow it would
  need a new IPC method and route; that is a separate ticket if wanted.
- Where to resolve → `rebuild_reverse`, over raw hrefs stored per Concept, the
  same split wikilinks already use. Cost is one `find_bundle_root` per rebuild,
  O(paths), next to the existing O(links) rebuild.
- Resolver → `links::resolve_link` with `exists = concepts.contains_key`, not a
  native copy of the rooting rules; it already includes the folder-index
  fallback, which drops the separate `folder_index_fallback` call there.
- Git prefix → an `Index` field set by `AppState` from `git_prefix()` once the
  index is built, then a `rebuild_reverse`. Tests set it directly. If the desktop
  runs a boot-time `git init` after `AppState::new`, set it after that instead.
