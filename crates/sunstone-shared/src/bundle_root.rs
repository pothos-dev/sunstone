//! Locating the OKF Bundle root WITHIN the opened tree.
//!
//! The folder Sunstone opens is often not the Bundle root: a repository keeps
//! its Bundle under `docs/`, and bundle-absolute links (`/x.md`) are authored
//! against THAT root. [`find_bundle_root`] answers "where is the root?" in rungs,
//! first match wins:
//!
//! 1. **The `okf_version` marker** ([`marker_root`]). OKF v0.2 §12 lets a
//!    bundle-root `index.md` declare `okf_version` — the only Frontmatter a
//!    Reserved file may carry — so an `index.md` that declares it is a positive
//!    root declaration and outranks every structural guess.
//! 2. **Structural inference** ([`structural_root`]), from the path list alone.
//!
//! The finder is PURE: it never reads a file. The marker reaches it as data
//! ([`OkfMarker`], parsed by the caller with
//! [`crate::frontmatter::okf_version_of`]) beside the path list, so the native
//! index, the wasm `BundleIndex` and the Playwright fake all run this one
//! function over the same inputs.
//!
//! A missing marker proves nothing (upstream issue #26: the reference agent's
//! index regeneration drops `okf_version`), so its absence falls through to the
//! structural rung rather than concluding there is no Bundle.

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

/// The detected Bundle root.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BundleRoot {
    /// Bundle-relative directory (`''` = the opened folder is the root).
    pub dir: String,
    /// The `okf_version` the root declares, when it was found by its marker.
    /// `None` means the root was inferred structurally — the Bundle does not
    /// declare itself (or does so ambiguously).
    pub okf_version: Option<String>,
}

/// The Bundle root within the opened tree: the [`marker_root`] when there is
/// one, else the [`structural_root`].
pub fn find_bundle_root(all_paths: &[String], markers: &[OkfMarker]) -> BundleRoot {
    marker_root(all_paths, markers).unwrap_or_else(|| BundleRoot {
        dir: structural_root(all_paths),
        okf_version: None,
    })
}

/// Rung 1: the directory whose `index.md` declares `okf_version`.
///
/// Only markers on an `index.md` that is in `all_paths` count. When several
/// declare it along one ancestor chain, the OUTERMOST wins — an inner
/// declaration is a nested Bundle, not the root. Several outermost markers in
/// unrelated directories (sibling Bundles side by side) are ambiguous: `None`,
/// so the caller falls through instead of guessing between them.
pub fn marker_root(all_paths: &[String], markers: &[OkfMarker]) -> Option<BundleRoot> {
    let declared: Vec<(&str, &OkfMarker)> = markers
        .iter()
        .filter(|m| basename(&m.index_path) == "index.md" && !m.okf_version.is_empty())
        .filter(|m| all_paths.contains(&m.index_path))
        .map(|m| (dir_of(&m.index_path), m))
        .collect();
    let encloses = |outer: &str, inner: &str| {
        outer != inner && (outer.is_empty() || inner.starts_with(&format!("{outer}/")))
    };
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
    })
}

/// Rung 2: best-effort structural inference from the path list alone, as a
/// bundle-relative prefix (`''` = the opened folder is itself the root).
pub fn structural_root(all_paths: &[String]) -> String {
    let mds: Vec<&String> = all_paths
        .iter()
        .filter(|p| p.to_lowercase().ends_with(".md"))
        .collect();
    if mds.is_empty() {
        return String::new();
    }

    // a. A top-level markdown file means the opened folder is the bundle root.
    if mds.iter().any(|p| !p.contains('/')) {
        return String::new();
    }

    // b. Shallowest directory carrying an index.md.
    let mut index_dirs: Vec<String> = Vec::new();
    for p in &mds {
        if basename(p) == "index.md" {
            let d = dir_of(p).to_string();
            if !index_dirs.contains(&d) {
                index_dirs.push(d);
            }
        }
    }
    if !index_dirs.is_empty() {
        let depth = |d: &str| d.split('/').count();
        let min_depth = index_dirs.iter().map(|d| depth(d)).min().unwrap();
        let shallow: Vec<&String> = index_dirs
            .iter()
            .filter(|d| depth(d) == min_depth)
            .collect();
        if shallow.iter().any(|d| d.as_str() == "docs") {
            return "docs".to_string();
        }
        if shallow.len() == 1 {
            return shallow[0].clone();
        }
        return String::new(); // ambiguous — several sibling bundles at the same depth
    }

    // c. No index.md anywhere: the sole shared top-level segment, if any.
    let mut top_segs: Vec<&str> = Vec::new();
    for p in &mds {
        let seg = p.split('/').next().unwrap_or("");
        if !top_segs.contains(&seg) {
            top_segs.push(seg);
        }
    }
    if top_segs.len() == 1 {
        top_segs[0].to_string()
    } else {
        String::new()
    }
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

    /// The root dir with no markers — today's structural behaviour.
    fn structural(ps: &[&str]) -> String {
        find_bundle_root(&paths(ps), &[]).dir
    }

    fn declared(dir: &str) -> BundleRoot {
        BundleRoot {
            dir: dir.to_string(),
            okf_version: Some("0.2".to_string()),
        }
    }

    fn inferred(dir: &str) -> BundleRoot {
        BundleRoot {
            dir: dir.to_string(),
            okf_version: None,
        }
    }

    // --- rung 1: the okf_version marker --------------------------------------

    #[test]
    fn a_declared_index_is_the_root_over_every_structural_rule() {
        // A top-level README would make the opened folder the root structurally.
        let ps = paths(&["README.md", "docs/index.md", "docs/a.md"]);
        assert_eq!(find_bundle_root(&ps, &[marker("docs/index.md")]), declared("docs"));
        // The shallowest-index rule would pick `wiki`; the marker picks deeper.
        let ps = paths(&["wiki/index.md", "wiki/kb/index.md", "wiki/kb/a.md"]);
        assert_eq!(find_bundle_root(&ps, &[marker("wiki/kb/index.md")]), declared("wiki/kb"));
        // Sibling indexes are ambiguous structurally; one declaring settles it.
        let ps = paths(&["notes/index.md", "wiki/index.md"]);
        assert_eq!(find_bundle_root(&ps, &[marker("wiki/index.md")]), declared("wiki"));
        // The `docs` tiebreak loses to a declaration.
        let ps = paths(&["docs/index.md", "kb/index.md"]);
        assert_eq!(find_bundle_root(&ps, &[marker("kb/index.md")]), declared("kb"));
        // A root `index.md` marker roots at the opened folder.
        let ps = paths(&["index.md", "a.md"]);
        assert_eq!(find_bundle_root(&ps, &[marker("index.md")]), declared(""));
    }

    #[test]
    fn the_declared_version_is_carried_verbatim() {
        let ps = paths(&["docs/index.md"]);
        let m = OkfMarker {
            index_path: "docs/index.md".to_string(),
            okf_version: "0.3-draft".to_string(),
        };
        assert_eq!(
            find_bundle_root(&ps, &[m]).okf_version.as_deref(),
            Some("0.3-draft")
        );
    }

    #[test]
    fn the_outermost_of_nested_markers_wins() {
        let ps = paths(&["repo/index.md", "repo/docs/index.md", "repo/docs/kb/index.md"]);
        let ms = [marker("repo/docs/kb/index.md"), marker("repo/index.md"), marker("repo/docs/index.md")];
        assert_eq!(find_bundle_root(&ps, &ms), declared("repo"));
        // The opened folder's own marker encloses everything.
        let ps = paths(&["index.md", "sub/index.md"]);
        assert_eq!(find_bundle_root(&ps, &[marker("sub/index.md"), marker("index.md")]), declared(""));
        // Whole segments only: `doc` does not enclose `docs`.
        let ps = paths(&["doc/index.md", "docs/index.md"]);
        assert_eq!(find_bundle_root(&ps, &[marker("doc/index.md"), marker("docs/index.md")]), inferred("docs"));
    }

    #[test]
    fn unrelated_markers_are_ambiguous_and_fall_through() {
        // Two declared Bundles side by side: no guess between them; the
        // structural rung decides exactly as it would with no markers.
        let ps = paths(&["notes/index.md", "wiki/index.md"]);
        let ms = [marker("notes/index.md"), marker("wiki/index.md")];
        assert_eq!(find_bundle_root(&ps, &ms), inferred(""));
        let ps = paths(&["docs/index.md", "kb/index.md"]);
        let ms = [marker("docs/index.md"), marker("kb/index.md")];
        assert_eq!(find_bundle_root(&ps, &ms), inferred("docs"));
        // A nested marker under one of them does not break the tie.
        let ps = paths(&["a/index.md", "a/x/index.md", "b/index.md"]);
        let ms = [marker("a/index.md"), marker("a/x/index.md"), marker("b/index.md")];
        assert_eq!(find_bundle_root(&ps, &ms), inferred(""));
    }

    #[test]
    fn markers_off_the_path_set_or_not_on_an_index_are_ignored() {
        let ps = paths(&["notes/index.md", "wiki/index.md", "wiki/a.md"]);
        // A stale marker for a file not in the set.
        assert_eq!(find_bundle_root(&ps, &[marker("gone/index.md")]), inferred(""));
        // `okf_version` on an ordinary Concept is not a root declaration.
        assert_eq!(find_bundle_root(&ps, &[marker("wiki/a.md")]), inferred(""));
        // An empty version is no declaration.
        let empty = OkfMarker {
            index_path: "wiki/index.md".to_string(),
            okf_version: String::new(),
        };
        assert_eq!(find_bundle_root(&ps, &[empty]), inferred(""));
    }

    #[test]
    fn no_markers_is_exactly_the_structural_rung() {
        for ps in [
            &["index.md", "tables/orders.md"][..],
            &["README.md", "docs/index.md"],
            &["docs/index.md", "docs/tables/orders.md"],
            &["wiki/index.md", "wiki/a/index.md", "wiki/a/b.md"],
            &["notes/index.md", "wiki/index.md"],
            &["docs/a.md", "docs/sub/b.md"],
        ] {
            assert_eq!(find_bundle_root(&paths(ps), &[]), inferred(&structural_root(&paths(ps))));
        }
    }

    // --- rung 2: structural inference (mirrors the former links.test.ts) -----

    #[test]
    fn empty_bundle_is_root() {
        assert_eq!(structural(&[]), "");
    }

    #[test]
    fn top_level_markdown_means_opened_folder_is_root() {
        assert_eq!(structural(&["index.md", "tables/orders.md"]), "");
        assert_eq!(structural(&["README.md", "docs/index.md"]), "");
    }

    #[test]
    fn nested_under_docs_found_via_index() {
        assert_eq!(structural(&["docs/index.md", "docs/tables/orders.md"]), "docs");
    }

    #[test]
    fn shallowest_index_wins() {
        assert_eq!(structural(&["wiki/index.md", "wiki/a/index.md", "wiki/a/b.md"]), "wiki");
    }

    #[test]
    fn docs_preferred_on_same_depth_tie() {
        assert_eq!(structural(&["docs/index.md", "notes/index.md"]), "docs");
    }

    #[test]
    fn ambiguous_same_depth_siblings_is_root() {
        assert_eq!(structural(&["notes/index.md", "wiki/index.md"]), "");
    }

    #[test]
    fn no_index_uses_sole_shared_top_segment() {
        assert_eq!(structural(&["docs/a.md", "docs/sub/b.md"]), "docs");
        assert_eq!(structural(&["docs/a.md", "other/b.md"]), "");
    }
}
