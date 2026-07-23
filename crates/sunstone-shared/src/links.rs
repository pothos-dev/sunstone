//! OKF markdown-link resolution (the former `src/lib/links.ts`), plus the wasm
//! boundary DTOs it produces (ADR 0006 §3/§6).
//!
//! `resolve_link` classifies a clicked `href` into external / internal / none,
//! carrying the target's bundle-relative path, a trailing `#anchor`, and — for
//! the wasm handle — whether the target `exists` in the concept set (§4). The
//! path-only core lives in [`crate::paths::resolve_internal`]; this adds the
//! `kind` classification, anchor extraction, and the nested-bundle-root
//! redirect. `find_bundle_root` locates the OKF root within the opened tree.

use serde::{Deserialize, Serialize};

use crate::paths::{dir_of, is_external, normalize_segments};
use crate::wikilink::basename;

/// The classified result of resolving a markdown link `href` (ADR 0006 §3).
/// Internally-tagged on `kind` (camelCase). The `internal` variant carries
/// `exists` — membership of the resolved path in the concept set — so the
/// broken-link decoration reads it directly instead of a second lookup.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResolvedLink {
    /// A `scheme:` URL the OS/browser opens; not navigated in-app.
    External { href: String },
    /// A bundle-relative OKF target. `anchor` is the trailing `#fragment`
    /// (without the `#`), or `None`. `exists` reports concept-set membership.
    Internal {
        path: String,
        anchor: Option<String>,
        exists: bool,
    },
    /// Nothing to navigate to (empty href, pure `#anchor`, or a path that
    /// normalizes to empty).
    None,
}

/// A resolved wikilink target: the bundle-relative path it points at. `null`
/// (a `None` return) means the wikilink is broken.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikilinkTarget {
    pub path: String,
}

/// The result of a live-buffer anchor rewrite: the rewritten body. The change
/// count stays Rust-internal (the frontend diffs old/new content itself).
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteBody {
    pub content: String,
}

/// The `#anchor` fragment of a link href (before any `?query`), or `None`.
fn extract_anchor(href: &str) -> Option<String> {
    let hash = href.find('#')?;
    let frag = &href[hash + 1..];
    let anchor = match frag.find('?') {
        Some(q) => &frag[..q],
        None => frag,
    };
    if anchor.is_empty() {
        None
    } else {
        Some(anchor.to_string())
    }
}

/// Apply the identified nested bundle root to a bundle-absolute target, with a
/// safe fallback: the root is only prepended when the rewritten path actually
/// resolves to an existing Concept; otherwise the original path is kept.
fn apply_bundle_root(path: &str, root: &str, exists: &impl Fn(&str) -> bool) -> String {
    if root.is_empty() {
        return path.to_string();
    }
    let rooted = format!("{root}/{path}");
    if exists(&rooted) {
        rooted
    } else {
        path.to_string()
    }
}

/// Resolve a markdown link `href` clicked inside the Concept at `current_path`
/// to a target. Mirrors the former `resolveLink` in `src/lib/links.ts` exactly.
///
/// When `bundle_root` is non-empty, bundle-absolute (`/…`) links resolve from
/// THAT root with a safe fallback (see `apply_bundle_root`); relative links are
/// never redirected. `exists` reports concept-set membership.
pub fn resolve_link(
    current_path: &str,
    href: &str,
    bundle_root: &str,
    exists: impl Fn(&str) -> bool,
) -> ResolvedLink {
    let raw = href.trim();
    if raw.is_empty() {
        return ResolvedLink::None;
    }
    // External (scheme) links are not navigated in-app.
    if is_external(raw) {
        return ResolvedLink::External {
            href: raw.to_string(),
        };
    }
    // Pure anchor: nothing to open (stay on the current Concept).
    if raw.starts_with('#') {
        return ResolvedLink::None;
    }

    // Separate the path component from a trailing `#anchor` (and any `?query`).
    let path_part = raw.split('#').next().unwrap_or("");
    let path_part = path_part.split('?').next().unwrap_or("");
    if path_part.is_empty() {
        return ResolvedLink::None;
    }
    let anchor = extract_anchor(raw);

    if let Some(stripped) = path_part.strip_prefix('/') {
        // Bundle-absolute: resolve from the bundle root (redirected into a
        // nested OKF root when one is identified and the rooted target exists).
        let path = normalize_segments(stripped.split('/'));
        if path.is_empty() {
            return ResolvedLink::None;
        }
        let path = apply_bundle_root(&path, bundle_root, &exists);
        let ex = exists(&path);
        return ResolvedLink::Internal {
            path,
            anchor,
            exists: ex,
        };
    }

    // Relative: resolve against the current Concept's directory.
    let dir = dir_of(current_path);
    let dir_segments: Vec<&str> = if dir.is_empty() {
        Vec::new()
    } else {
        dir.split('/').collect()
    };
    let path = normalize_segments(dir_segments.into_iter().chain(path_part.split('/')));
    if path.is_empty() {
        return ResolvedLink::None;
    }
    let ex = exists(&path);
    ResolvedLink::Internal {
        path,
        anchor,
        exists: ex,
    }
}

/// Best-effort location of the OKF bundle root WITHIN the opened tree, as a
/// bundle-relative prefix (`''` = the opened folder is itself the bundle root).
/// Mirrors the former `findBundleRoot` in `src/lib/links.ts` exactly.
pub fn find_bundle_root(all_paths: &[String]) -> String {
    let mds: Vec<&String> = all_paths
        .iter()
        .filter(|p| p.to_lowercase().ends_with(".md"))
        .collect();
    if mds.is_empty() {
        return String::new();
    }

    // 1. A top-level markdown file means the opened folder is the bundle root.
    if mds.iter().any(|p| !p.contains('/')) {
        return String::new();
    }

    // 2. Shallowest directory carrying an index.md.
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

    // 3. No index.md anywhere: the sole shared top-level segment, if any.
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

    fn no_exists(_: &str) -> bool {
        false
    }

    // --- resolve_link (mirrors links.test.ts::resolveLink) -------------------

    #[test]
    fn empty_or_whitespace_is_none() {
        assert_eq!(resolve_link("a.md", "", "", no_exists), ResolvedLink::None);
        assert_eq!(
            resolve_link("a.md", "   ", "", no_exists),
            ResolvedLink::None
        );
    }

    #[test]
    fn external_passes_through_trimmed() {
        assert_eq!(
            resolve_link("a.md", "  https://x.com  ", "", no_exists),
            ResolvedLink::External {
                href: "https://x.com".to_string()
            }
        );
    }

    #[test]
    fn pure_anchor_is_none() {
        assert_eq!(
            resolve_link("a.md", "#heading", "", no_exists),
            ResolvedLink::None
        );
    }

    #[test]
    fn bundle_absolute_strips_leading_slash() {
        assert_eq!(
            resolve_link("dir/cur.md", "/foo/bar.md", "", no_exists),
            ResolvedLink::Internal {
                path: "foo/bar.md".to_string(),
                anchor: None,
                exists: false
            }
        );
    }

    #[test]
    fn relative_resolves_against_current_dir() {
        assert_eq!(
            resolve_link("dir/cur.md", "./sib.md", "", no_exists),
            ResolvedLink::Internal {
                path: "dir/sib.md".to_string(),
                anchor: None,
                exists: false
            }
        );
        assert_eq!(
            resolve_link("cur.md", "bare.md", "", no_exists),
            ResolvedLink::Internal {
                path: "bare.md".to_string(),
                anchor: None,
                exists: false
            }
        );
    }

    #[test]
    fn parent_segments_normalized_and_escapes_dropped() {
        assert_eq!(
            resolve_link("dir/sub/cur.md", "../up.md", "", no_exists),
            ResolvedLink::Internal {
                path: "dir/up.md".to_string(),
                anchor: None,
                exists: false
            }
        );
        assert_eq!(
            resolve_link("cur.md", "/../x.md", "", no_exists),
            ResolvedLink::Internal {
                path: "x.md".to_string(),
                anchor: None,
                exists: false
            }
        );
    }

    #[test]
    fn anchor_carried_query_dropped() {
        assert_eq!(
            resolve_link("cur.md", "path.md#sec", "", no_exists),
            ResolvedLink::Internal {
                path: "path.md".to_string(),
                anchor: Some("sec".to_string()),
                exists: false
            }
        );
        assert_eq!(
            resolve_link("cur.md", "/path.md?x=1#sec", "", no_exists),
            ResolvedLink::Internal {
                path: "path.md".to_string(),
                anchor: Some("sec".to_string()),
                exists: false
            }
        );
    }

    #[test]
    fn absolute_normalizing_to_empty_is_none() {
        assert_eq!(resolve_link("cur.md", "/", "", no_exists), ResolvedLink::None);
        assert_eq!(
            resolve_link("cur.md", "/.", "", no_exists),
            ResolvedLink::None
        );
    }

    #[test]
    fn nested_root_prepended_when_target_exists() {
        let known = paths(&["docs/index.md", "docs/tables/orders.md"]);
        let exists = |p: &str| known.iter().any(|k| k == p);
        assert_eq!(
            resolve_link("docs/index.md", "/tables/orders.md", "docs", exists),
            ResolvedLink::Internal {
                path: "docs/tables/orders.md".to_string(),
                anchor: None,
                exists: true
            }
        );
    }

    #[test]
    fn nested_root_safe_fallback_when_missing() {
        assert_eq!(
            resolve_link("docs/index.md", "/tables/orders.md", "docs", no_exists),
            ResolvedLink::Internal {
                path: "tables/orders.md".to_string(),
                anchor: None,
                exists: false
            }
        );
    }

    #[test]
    fn empty_root_is_a_noop() {
        assert_eq!(
            resolve_link("cur.md", "/x.md", "", |_| true),
            ResolvedLink::Internal {
                path: "x.md".to_string(),
                anchor: None,
                exists: true
            }
        );
    }

    #[test]
    fn relative_never_redirected_into_root() {
        assert_eq!(
            resolve_link("docs/tables/cur.md", "./orders.md", "docs", |_| true),
            ResolvedLink::Internal {
                path: "docs/tables/orders.md".to_string(),
                anchor: None,
                exists: true
            }
        );
    }

    #[test]
    fn carries_anchor_through_redirect() {
        let known = paths(&["docs/tables/orders.md"]);
        let exists = |p: &str| known.iter().any(|k| k == p);
        assert_eq!(
            resolve_link("docs/index.md", "/tables/orders.md#schema", "docs", exists),
            ResolvedLink::Internal {
                path: "docs/tables/orders.md".to_string(),
                anchor: Some("schema".to_string()),
                exists: true
            }
        );
    }

    // --- find_bundle_root (mirrors links.test.ts::findBundleRoot) ------------

    #[test]
    fn empty_bundle_is_root() {
        assert_eq!(find_bundle_root(&[]), "");
    }

    #[test]
    fn top_level_markdown_means_opened_folder_is_root() {
        assert_eq!(find_bundle_root(&paths(&["index.md", "tables/orders.md"])), "");
        assert_eq!(find_bundle_root(&paths(&["README.md", "docs/index.md"])), "");
    }

    #[test]
    fn nested_under_docs_found_via_index() {
        assert_eq!(
            find_bundle_root(&paths(&["docs/index.md", "docs/tables/orders.md"])),
            "docs"
        );
    }

    #[test]
    fn shallowest_index_wins() {
        assert_eq!(
            find_bundle_root(&paths(&["wiki/index.md", "wiki/a/index.md", "wiki/a/b.md"])),
            "wiki"
        );
    }

    #[test]
    fn docs_preferred_on_same_depth_tie() {
        assert_eq!(
            find_bundle_root(&paths(&["docs/index.md", "notes/index.md"])),
            "docs"
        );
    }

    #[test]
    fn ambiguous_same_depth_siblings_is_root() {
        assert_eq!(
            find_bundle_root(&paths(&["notes/index.md", "wiki/index.md"])),
            ""
        );
    }

    #[test]
    fn no_index_uses_sole_shared_top_segment() {
        assert_eq!(
            find_bundle_root(&paths(&["docs/a.md", "docs/sub/b.md"])),
            "docs"
        );
        assert_eq!(find_bundle_root(&paths(&["docs/a.md", "other/b.md"])), "");
    }
}
