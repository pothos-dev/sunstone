//! Locating the OKF Bundle root WITHIN the opened tree.
//!
//! The folder Sunstone opens is often not the Bundle root: a repository keeps
//! its Bundle under `docs/`, and bundle-absolute links (`/x.md`) are authored
//! against THAT root. [`find_bundle_root`] answers "where is the root?" as an
//! ordered ladder of named [`RootRung`]s, first match wins:
//!
//! 1. **The `okf_version` marker** ([`marker_root`]). OKF v0.2 §12 lets a
//!    bundle-root `index.md` declare `okf_version` — the only Frontmatter a
//!    Reserved file may carry — so an `index.md` that declares it is a positive
//!    root declaration and outranks every guess below.
//! 2. **The `index.md` chain** ([`index_chain_root`]): the outermost directory
//!    carrying an `index.md`. Gaps do not stop it (an `index.md` is optional at
//!    every level); same-depth siblings are ambiguous and fall through.
//! 3. **The git toplevel** ([`git_toplevel_root`]): OKF names a git repository
//!    as the recommended distribution unit, so the repository containing the
//!    opened folder is the root — possibly ABOVE the opened folder.
//! 4. **The opened folder** ([`opened_folder_root`]), always: bundle-absolute
//!    links degrade to resolving against the linking Concept's own directory.
//!
//! Whatever the rung, [`BundleRoot::anchor`] only proposes a candidate; the
//! caller (`links::resolve_link`) takes it only when it EXISTS, so a mis-found
//! root can never break a link that would have worked against the opened folder.
//!
//! The finder is PURE: it never reads a file or runs git. Filesystem facts reach
//! it as data — the markers ([`OkfMarker`], parsed by the caller with
//! [`crate::frontmatter::okf_version_of`]) and the opened folder's git prefix —
//! so the desktop, the web frontend and the Playwright fake all run this one
//! function over the same inputs.
//!
//! A missing marker proves nothing (upstream issue #26: the reference agent's
//! index regeneration drops `okf_version`), so its absence falls through to the
//! next rung rather than concluding there is no Bundle.
//!
//! A user-chosen root (ticket ov-7, [`override_root`]) sits ON TOP of this
//! ladder: rung 0, [`RootRung::Override`]. When the caller hands one in, the
//! ladder is skipped entirely — the override is the user correcting the guess,
//! so nothing re-derives over it. It resolves through [`BundleRoot::anchor`]
//! like a detected root. The override is per-user View state (persisted outside
//! the Bundle, never in it); it reaches the finder as data like every other fact.

use serde::{Deserialize, Serialize};

use crate::paths::dir_of;
use crate::wikilink::basename;

/// A reserved `index.md` whose Frontmatter declares `okf_version` (OKF v0.2
/// §12). Built by whoever holds the content — the native index, the fake's
/// store — and handed to [`find_bundle_root`] beside the path list.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OkfMarker {
    /// Bundle-relative path of the `index.md` (`index.md`, `docs/index.md`, …).
    pub index_path: String,
    /// The declared version, verbatim (`"0.2"`). Never empty.
    pub okf_version: String,
}

/// Which rung of the ladder found the root, carrying what that rung needs to
/// anchor a bundle-absolute link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootRung {
    /// The user set the root explicitly (ticket ov-7): outranks every rung.
    Override,
    /// An `index.md` declaring `okf_version` (OKF v0.2 §12).
    Marker,
    /// The outermost directory carrying an `index.md`.
    IndexChain,
    /// The git repository containing the opened folder. `opened_at` is the
    /// opened folder's path within the repository (`''` = the opened folder is
    /// the toplevel; `docs` = the repository root lies one level above it).
    GitToplevel { opened_at: String },
    /// Nothing else matched: the opened folder, with bundle-absolute links
    /// resolved against the linking Concept's own directory.
    OpenedFolder,
}

/// The detected Bundle root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleRoot {
    /// Bundle-relative directory (`''` = the opened folder, or a root above it).
    pub dir: String,
    /// The `okf_version` the root declares, when it was found by its marker.
    /// `None` means the root was inferred — the Bundle does not declare itself
    /// (or does so ambiguously).
    pub okf_version: Option<String>,
    /// The rung that found it.
    pub rung: RootRung,
}

impl BundleRoot {
    /// A root at `dir` found by an inferring rung (no declared version).
    fn inferred(dir: impl Into<String>, rung: RootRung) -> BundleRoot {
        BundleRoot {
            dir: dir.into(),
            okf_version: None,
            rung,
        }
    }

    /// Where a bundle-absolute link's `path` (normalised, leading `/` dropped,
    /// `''` = the root itself) lands under this root when linked from the
    /// Concept at `current_path`, or `None` when the root does not move it.
    /// Only a CANDIDATE: the caller keeps `path` unless the candidate exists.
    pub fn anchor(&self, current_path: &str, path: &str) -> Option<String> {
        let under = |dir: &str| match (dir.is_empty(), path.is_empty()) {
            (true, _) => None,
            (false, true) => Some(dir.to_string()),
            (false, false) => Some(format!("{dir}/{path}")),
        };
        match &self.rung {
            RootRung::Override | RootRung::Marker | RootRung::IndexChain => under(&self.dir),
            RootRung::OpenedFolder => under(dir_of(current_path)),
            // Authored against a repository root above the opened folder: strip
            // the opened folder's own path off the front.
            RootRung::GitToplevel { opened_at } if !opened_at.is_empty() => {
                if path == opened_at {
                    Some(String::new())
                } else {
                    path.strip_prefix(&format!("{opened_at}/")).map(str::to_string)
                }
            }
            RootRung::GitToplevel { .. } => None,
        }
    }
}

/// The Bundle root within the opened tree: the first rung of the ladder that
/// matches (see the module docs). `git_prefix` is the opened folder's path
/// within its git repository as `git rev-parse --show-prefix` reports it (`''`
/// at the toplevel; a trailing `/` is tolerated), `None` outside a repository.
/// `root_override` is the user's explicit choice (bundle-relative directory,
/// `''` = the opened folder): when it is a clean path it wins outright.
pub fn find_bundle_root(
    all_paths: &[String],
    markers: &[OkfMarker],
    git_prefix: Option<&str>,
    root_override: Option<&str>,
) -> BundleRoot {
    root_override
        .and_then(|dir| override_root(dir, markers))
        .or_else(|| marker_root(all_paths, markers))
        .or_else(|| index_chain_root(all_paths))
        .or_else(|| git_toplevel_root(git_prefix))
        .unwrap_or_else(opened_folder_root)
}

/// Rung 0: the user's explicit root (ticket ov-7). `dir` must be a clean
/// bundle-relative directory — forward-slash, no empty, `.`, `..` or hidden
/// (dot-prefixed) segment — else it is ignored (`None`) and the ladder runs as
/// if no override were set: View state is untrusted input. The folder need not
/// exist or hold an `index.md`; the version is carried only when its own
/// `index.md` declares one, so OKF behaviour stays gated on the marker.
pub fn override_root(dir: &str, markers: &[OkfMarker]) -> Option<BundleRoot> {
    let clean = dir.is_empty()
        || dir
            .split('/')
            .all(|seg| !seg.is_empty() && !seg.starts_with('.') && !seg.contains('\\'));
    if !clean {
        return None;
    }
    let index = if dir.is_empty() {
        "index.md".to_string()
    } else {
        format!("{dir}/index.md")
    };
    let okf_version = markers
        .iter()
        .find(|m| m.index_path == index && !m.okf_version.is_empty())
        .map(|m| m.okf_version.clone());
    Some(BundleRoot {
        dir: dir.to_string(),
        okf_version,
        rung: RootRung::Override,
    })
}

/// Whether directory `outer` strictly encloses `inner` (whole segments; `''`
/// encloses everything but itself).
fn encloses(outer: &str, inner: &str) -> bool {
    outer != inner && (outer.is_empty() || inner.starts_with(&format!("{outer}/")))
}

/// Rung 1: the directory whose `index.md` declares `okf_version`.
///
/// Only markers on an `index.md` that is in `all_paths` count. When several
/// declare it along one ancestor chain, the OUTERMOST wins — an inner
/// declaration is a nested Bundle, not the root. Several outermost markers in
/// unrelated directories (sibling Bundles side by side) are ambiguous: `None`,
/// so the ladder falls through instead of guessing between them.
pub fn marker_root(all_paths: &[String], markers: &[OkfMarker]) -> Option<BundleRoot> {
    let declared: Vec<(&str, &OkfMarker)> = markers
        .iter()
        .filter(|m| basename(&m.index_path) == "index.md" && !m.okf_version.is_empty())
        .filter(|m| all_paths.contains(&m.index_path))
        .map(|m| (dir_of(&m.index_path), m))
        .collect();
    let mut outermost = declared
        .iter()
        .filter(|(d, _)| !declared.iter().any(|(o, _)| encloses(o, d)));
    let (dir, marker) = outermost.next()?;
    if outermost.any(|(other, _)| other != dir) {
        return None;
    }
    Some(BundleRoot {
        dir: dir.to_string(),
        okf_version: Some(marker.okf_version.clone()),
        rung: RootRung::Marker,
    })
}

/// Rung 2: the outermost directory carrying an `index.md`.
///
/// Every `index.md` in `all_paths` names a candidate. One enclosed by another
/// is a nested section, never the root, and an index-less directory between
/// them (a gap) changes nothing. Among the outermost candidates the shallowest
/// wins; on a depth tie the canonical `docs` wins, and any other tie (sibling
/// Bundles side by side) is ambiguous: `None`, no guess.
pub fn index_chain_root(all_paths: &[String]) -> Option<BundleRoot> {
    let mut dirs: Vec<&str> = all_paths
        .iter()
        .filter(|p| basename(p) == "index.md")
        .map(|p| dir_of(p))
        .collect();
    dirs.sort_unstable();
    dirs.dedup();
    let outermost: Vec<&str> = dirs
        .iter()
        .copied()
        .filter(|d| !dirs.iter().any(|o| encloses(o, d)))
        .collect();
    let depth = |d: &str| if d.is_empty() { 0 } else { d.split('/').count() };
    let min_depth = outermost.iter().map(|d| depth(d)).min()?;
    let shallowest: Vec<&str> = outermost
        .into_iter()
        .filter(|d| depth(d) == min_depth)
        .collect();
    let dir = match shallowest.as_slice() {
        [only] => *only,
        several if several.contains(&"docs") => "docs",
        _ => return None,
    };
    Some(BundleRoot::inferred(dir, RootRung::IndexChain))
}

/// Rung 3: the git repository containing the opened folder. `git_prefix` is
/// the opened folder's path within it (`''` = the toplevel itself), `None`
/// when the opened folder is not inside a repository.
pub fn git_toplevel_root(git_prefix: Option<&str>) -> Option<BundleRoot> {
    let opened_at = git_prefix?.trim_matches('/').to_string();
    Some(BundleRoot::inferred("", RootRung::GitToplevel { opened_at }))
}

/// Rung 4, the floor: the opened folder, bundle-absolute links resolving
/// against the linking Concept's own directory.
pub fn opened_folder_root() -> BundleRoot {
    BundleRoot::inferred("", RootRung::OpenedFolder)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(ps: &[&str]) -> Vec<String> {
        ps.iter().map(|s| s.to_string()).collect()
    }

    fn marker(index_path: &str) -> OkfMarker {
        OkfMarker {
            index_path: index_path.to_string(),
            okf_version: "0.2".to_string(),
        }
    }

    /// The ladder outside any git repository and with no markers.
    fn found(ps: &[&str]) -> BundleRoot {
        find_bundle_root(&paths(ps), &[], None, None)
    }

    fn declared(dir: &str) -> BundleRoot {
        BundleRoot {
            dir: dir.to_string(),
            okf_version: Some("0.2".to_string()),
            rung: RootRung::Marker,
        }
    }

    fn chain(dir: &str) -> BundleRoot {
        BundleRoot::inferred(dir, RootRung::IndexChain)
    }

    fn git(opened_at: &str) -> BundleRoot {
        BundleRoot::inferred(
            "",
            RootRung::GitToplevel {
                opened_at: opened_at.to_string(),
            },
        )
    }

    fn opened() -> BundleRoot {
        opened_folder_root()
    }

    // --- rung 0: the user's override (ov-7) -----------------------------------

    fn chosen(dir: &str) -> BundleRoot {
        BundleRoot::inferred(dir, RootRung::Override)
    }

    #[test]
    fn an_override_outranks_every_rung_of_the_ladder() {
        let ps = paths(&["index.md", "docs/index.md", "wiki/a.md"]);
        let ms = [marker("index.md")];
        assert_eq!(find_bundle_root(&ps, &ms, Some(""), Some("wiki")), chosen("wiki"));
        assert_eq!(find_bundle_root(&ps, &[], None, Some("docs")).rung, RootRung::Override);
        // `''` pins the opened folder itself, over a chain that would pick `docs`.
        let ps = paths(&["README.md", "docs/index.md"]);
        assert_eq!(find_bundle_root(&ps, &[], Some(""), Some("")), chosen(""));
    }

    #[test]
    fn an_override_need_not_exist_or_hold_an_index() {
        assert_eq!(find_bundle_root(&paths(&["a.md"]), &[], None, Some("gone/away")), chosen("gone/away"));
    }

    #[test]
    fn an_override_carries_only_its_own_declared_version() {
        let ps = paths(&["index.md", "kb/index.md"]);
        let root = find_bundle_root(&ps, &[marker("kb/index.md")], None, Some("kb"));
        assert_eq!(root.okf_version.as_deref(), Some("0.2"));
        let root = find_bundle_root(&ps, &[marker("index.md")], None, Some("kb"));
        assert_eq!(root.okf_version, None);
        let root = find_bundle_root(&ps, &[marker("index.md")], None, Some(""));
        assert_eq!(root.okf_version.as_deref(), Some("0.2"));
    }

    #[test]
    fn an_unclean_override_is_ignored_and_the_ladder_runs() {
        let ps = paths(&["docs/index.md"]);
        for bad in ["/docs", "docs/", "../x", "a/../b", "./docs", ".git", "a/.hidden", "a//b", "a\\b"] {
            assert_eq!(find_bundle_root(&ps, &[], None, Some(bad)), chain("docs"), "{bad}");
        }
    }

    #[test]
    fn an_override_anchors_like_a_directory_root() {
        assert_eq!(chosen("kb").anchor("a/b.md", "x.md"), Some("kb/x.md".into()));
        assert_eq!(chosen("kb").anchor("a/b.md", ""), Some("kb".into()));
        assert_eq!(chosen("").anchor("a/b.md", "x.md"), None);
    }

    // --- rung 1: the okf_version marker --------------------------------------

    #[test]
    fn a_declared_index_is_the_root_over_every_later_rung() {
        // A root index would win the index chain; the declaration goes deeper.
        let ps = paths(&["index.md", "docs/index.md", "docs/a.md"]);
        assert_eq!(find_bundle_root(&ps, &[marker("docs/index.md")], Some(""), None), declared("docs"));
        // The outermost-index rule would pick `wiki`; the marker picks deeper.
        let ps = paths(&["wiki/index.md", "wiki/kb/index.md", "wiki/kb/a.md"]);
        assert_eq!(find_bundle_root(&ps, &[marker("wiki/kb/index.md")], None, None), declared("wiki/kb"));
        // Sibling indexes are ambiguous on the chain; one declaring settles it.
        let ps = paths(&["notes/index.md", "wiki/index.md"]);
        assert_eq!(find_bundle_root(&ps, &[marker("wiki/index.md")], None, None), declared("wiki"));
        // The `docs` tiebreak loses to a declaration.
        let ps = paths(&["docs/index.md", "kb/index.md"]);
        assert_eq!(find_bundle_root(&ps, &[marker("kb/index.md")], None, None), declared("kb"));
        // A root `index.md` marker roots at the opened folder.
        let ps = paths(&["index.md", "a.md"]);
        assert_eq!(find_bundle_root(&ps, &[marker("index.md")], None, None), declared(""));
    }

    #[test]
    fn the_declared_version_is_carried_verbatim() {
        let ps = paths(&["docs/index.md"]);
        let m = OkfMarker {
            index_path: "docs/index.md".to_string(),
            okf_version: "0.3-draft".to_string(),
        };
        assert_eq!(
            find_bundle_root(&ps, &[m], None, None).okf_version.as_deref(),
            Some("0.3-draft")
        );
    }

    #[test]
    fn the_outermost_of_nested_markers_wins() {
        let ps = paths(&["repo/index.md", "repo/docs/index.md", "repo/docs/kb/index.md"]);
        let ms = [marker("repo/docs/kb/index.md"), marker("repo/index.md"), marker("repo/docs/index.md")];
        assert_eq!(find_bundle_root(&ps, &ms, None, None), declared("repo"));
        // The opened folder's own marker encloses everything.
        let ps = paths(&["index.md", "sub/index.md"]);
        assert_eq!(find_bundle_root(&ps, &[marker("sub/index.md"), marker("index.md")], None, None), declared(""));
        // Whole segments only: `doc` does not enclose `docs`.
        let ps = paths(&["doc/index.md", "docs/index.md"]);
        assert_eq!(find_bundle_root(&ps, &[marker("doc/index.md"), marker("docs/index.md")], None, None), chain("docs"));
    }

    #[test]
    fn unrelated_markers_are_ambiguous_and_fall_through() {
        // Two declared Bundles side by side: no guess between them; the later
        // rungs decide exactly as they would with no markers.
        let ps = paths(&["notes/index.md", "wiki/index.md"]);
        let ms = [marker("notes/index.md"), marker("wiki/index.md")];
        assert_eq!(find_bundle_root(&ps, &ms, None, None), opened());
        assert_eq!(find_bundle_root(&ps, &ms, Some(""), None), git(""));
        let ps = paths(&["docs/index.md", "kb/index.md"]);
        let ms = [marker("docs/index.md"), marker("kb/index.md")];
        assert_eq!(find_bundle_root(&ps, &ms, None, None), chain("docs"));
        // A nested marker under one of them does not break the tie.
        let ps = paths(&["a/index.md", "a/x/index.md", "b/index.md"]);
        let ms = [marker("a/index.md"), marker("a/x/index.md"), marker("b/index.md")];
        assert_eq!(find_bundle_root(&ps, &ms, None, None), opened());
    }

    #[test]
    fn markers_off_the_path_set_or_not_on_an_index_are_ignored() {
        let ps = paths(&["notes/index.md", "wiki/index.md", "wiki/a.md"]);
        // A stale marker for a file not in the set.
        assert_eq!(find_bundle_root(&ps, &[marker("gone/index.md")], None, None), opened());
        // `okf_version` on an ordinary Concept is not a root declaration.
        assert_eq!(find_bundle_root(&ps, &[marker("wiki/a.md")], None, None), opened());
        // An empty version is no declaration.
        let empty = OkfMarker {
            index_path: "wiki/index.md".to_string(),
            okf_version: String::new(),
        };
        assert_eq!(find_bundle_root(&ps, &[empty], None, None), opened());
    }

    // --- rung 2: the index.md chain ------------------------------------------

    #[test]
    fn the_outermost_index_of_a_chain_wins() {
        assert_eq!(found(&["docs/index.md", "docs/tables/orders.md"]), chain("docs"));
        assert_eq!(found(&["wiki/index.md", "wiki/a/index.md", "wiki/a/b.md"]), chain("wiki"));
        // A root index makes the opened folder the root.
        assert_eq!(found(&["index.md", "tables/index.md", "tables/orders.md"]), chain(""));
    }

    #[test]
    fn a_gap_in_the_chain_does_not_stop_the_walk() {
        // `kb/a` and `kb/a/b` carry no index.md; `kb` still roots the chain.
        assert_eq!(found(&["kb/index.md", "kb/a/b/c/index.md", "kb/a/b/x.md"]), chain("kb"));
        // Nor does an index-less opened folder above it.
        assert_eq!(found(&["repo/docs/index.md", "repo/docs/a/b/index.md"]), chain("repo/docs"));
    }

    #[test]
    fn top_level_concepts_do_not_pin_the_opened_folder() {
        // A repository's README beside its Bundle under `docs/`.
        assert_eq!(found(&["README.md", "docs/index.md", "docs/a.md"]), chain("docs"));
    }

    #[test]
    fn the_shallowest_outermost_index_wins_across_unrelated_trees() {
        assert_eq!(found(&["docs/index.md", "src/ui/index.md"]), chain("docs"));
        assert_eq!(found(&["wiki/index.md", "notes/deep/index.md"]), chain("wiki"));
    }

    #[test]
    fn docs_wins_a_same_depth_tie() {
        assert_eq!(found(&["docs/index.md", "notes/index.md"]), chain("docs"));
        assert_eq!(found(&["doc/index.md", "docs/index.md"]), chain("docs"));
    }

    #[test]
    fn ambiguous_siblings_do_not_guess() {
        let ps = paths(&["notes/index.md", "wiki/index.md", "wiki/a.md"]);
        assert_eq!(index_chain_root(&ps), None);
        assert_eq!(find_bundle_root(&ps, &[], None, None), opened());
        assert_eq!(find_bundle_root(&ps, &[], Some(""), None), git(""));
    }

    // --- rung 3: the git toplevel ---------------------------------------------

    #[test]
    fn no_index_anywhere_roots_at_the_git_toplevel() {
        let ps = paths(&["docs/a.md", "docs/sub/b.md"]);
        assert_eq!(find_bundle_root(&ps, &[], Some(""), None), git(""));
        // The opened folder is a subdirectory of the repository.
        assert_eq!(find_bundle_root(&ps, &[], Some("handbook/"), None), git("handbook"));
        assert_eq!(find_bundle_root(&ps, &[], Some("a/b"), None), git("a/b"));
        // An empty tree inside a repository, too.
        assert_eq!(find_bundle_root(&[], &[], Some(""), None), git(""));
    }

    #[test]
    fn an_index_chain_outranks_the_git_toplevel() {
        let ps = paths(&["README.md", "docs/index.md"]);
        assert_eq!(find_bundle_root(&ps, &[], Some(""), None), chain("docs"));
    }

    // --- rung 4: the opened folder --------------------------------------------

    #[test]
    fn with_every_rung_exhausted_the_opened_folder_is_the_root() {
        assert_eq!(found(&[]), opened());
        assert_eq!(found(&["a.md", "docs/b.md"]), opened());
        assert_eq!(found(&["docs/a.md", "docs/sub/b.md"]), opened());
    }

    // --- anchoring a bundle-absolute link per rung ----------------------------

    #[test]
    fn a_directory_root_prefixes_its_dir() {
        for root in [declared("docs"), chain("docs")] {
            assert_eq!(root.anchor("docs/a.md", "x.md"), Some("docs/x.md".into()));
            assert_eq!(root.anchor("README.md", ""), Some("docs".into()));
        }
        // A root at the opened folder moves nothing.
        assert_eq!(chain("").anchor("a/b.md", "x.md"), None);
        assert_eq!(declared("").anchor("a/b.md", "x.md"), None);
    }

    #[test]
    fn a_git_root_above_the_opened_folder_strips_its_prefix() {
        let root = git("handbook");
        assert_eq!(root.anchor("a.md", "handbook/x/y.md"), Some("x/y.md".into()));
        assert_eq!(root.anchor("a.md", "handbook"), Some(String::new()));
        // Whole segments only, and a link outside the opened folder stays put.
        assert_eq!(root.anchor("a.md", "handbooks/x.md"), None);
        assert_eq!(root.anchor("a.md", "README.md"), None);
        // At the toplevel the opened folder IS the root.
        assert_eq!(git("").anchor("a/b.md", "x.md"), None);
    }

    #[test]
    fn the_opened_folder_anchors_at_the_concepts_own_directory() {
        let root = opened();
        assert_eq!(root.anchor("guide/setup.md", "x.md"), Some("guide/x.md".into()));
        assert_eq!(root.anchor("guide/deep/setup.md", "y/z.md"), Some("guide/deep/y/z.md".into()));
        assert_eq!(root.anchor("guide/setup.md", ""), Some("guide".into()));
        // A top-level Concept's own directory is the opened folder.
        assert_eq!(root.anchor("top.md", "x.md"), None);
    }
}
