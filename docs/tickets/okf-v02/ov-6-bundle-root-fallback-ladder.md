---
status: done
blocked-by: [ov-5]
---

# ov-6: Complete the Bundle root fallback ladder

**What to build:** a Bundle that ships no `okf_version` marker still roots predictably, and an unrootable folder degrades safely instead of mis-navigating. With the marker rung in place, the remaining rungs become explicit and ordered rather than an ad-hoc sequence of heuristics: after the marker, prefer the outermost directory in the chain of directories carrying an `index.md` — tolerating gaps, since an `index.md` is optional at every level — then the git repository toplevel, since OKF names git as the recommended distribution unit, and finally the opened folder itself, with bundle-absolute links degrading to resolving against the Concept's own directory.

Sunstone already implements something close for the middle rungs: shallowest directory with an `index.md`, a `docs/` tiebreak, and a shared-top-level-segment guess. This ticket restates them as a documented ladder, adds the git-toplevel rung, and keeps the existing safety property — a bundle-absolute link is only rewritten when the rewritten target actually exists, so a mis-identified root can never break a link that would otherwise have worked.

- [x] Root detection runs as an ordered ladder whose rungs are named and individually testable
- [x] When no marker exists, the outermost directory in an `index.md` chain wins, and a gap in the chain does not stop the walk
- [x] A Bundle with no `index.md` anywhere roots at the git toplevel when the opened folder is inside a repository
- [x] With every rung exhausted, bundle-absolute links resolve against the Concept's own directory and are styled broken only when genuinely absent
- [x] The existence-gated rewrite guarantee still holds at every rung
- [x] Unit tests cover each rung and each fallthrough, including the ambiguous-siblings case that must not guess
- [x] The Bundle page's root-detection section describes the full ladder and where Sunstone extends the spec
- [x] All four gates green

## Resolution

`crates/sunstone-shared/src/bundle_root.rs` is now the ladder:
`find_bundle_root(paths, markers, git_prefix) -> BundleRoot { dir, okf_version, rung }`
tries `marker_root` → `index_chain_root` → `git_toplevel_root` →
`opened_folder_root`, each a public function with its own tests. `RootRung`
names the rung that matched. `BundleRoot::anchor(current, path)` says where a
bundle-absolute link lands under that rung, and `links::resolve_link` (which now
takes the `&BundleRoot`) takes that candidate only when it exists, so the
existence gate covers every rung by construction.

The git fact is fed in as data, like the markers: `git::repo_prefix`
(`git rev-parse --show-prefix`), cached per opened Bundle in
`AppState::git_prefix`, served as the new `Backend.gitPrefix()`
(`git_prefix` command / `GET /_api/git-prefix` / fake `''`). `indexStore` hands
it to `BundleIndex(paths, markers, gitPrefix)`.

Calls made inside the ticket's frame:

- **Old structural rules retired.** "A top-level `.md` means the opened folder is
  the root" is gone: it defeated the motivating case (a repository's
  `README.md` beside `docs/index.md`), and the ladder has no such rung. The
  shared-top-level-segment guess is gone too; with no `index.md` the git and
  opened-folder rungs decide. The shallowest-index rule and the `docs/` tiebreak
  survive as rung 2 (the outermost of a chain is its shallowest; across
  unrelated trees the shallowest wins; same-depth non-`docs` siblings decline).
- **Git toplevel above the opened folder.** `sunstone ./handbook` inside a
  repository roots at the repository: `/handbook/x.md` resolves to the opened
  folder's `x.md` (prefix stripped, existence-gated).
- **Opened-folder rung.** `/p` from `a/b.md` tries `a/p` first, then `p`; broken
  only when neither exists.

**Seam for ov-7:** the override is one more rung ahead of `RootRung::Marker` —
add a `RootRung::Override` variant (anchoring like `Marker`, `under(dir)`) and an
`Option<&str>` input to `find_bundle_root` (and `BundleIndex::new`) that
short-circuits the ladder. Resolution needs nothing new.
