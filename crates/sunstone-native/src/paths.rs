//! Shared bundle-path and filesystem-walk helpers.
//!
//! Consolidates logic that was previously duplicated across `bundle.rs`,
//! `index.rs`, `search.rs`, and `rewrite.rs`: the canonical Bundle file walker
//! and bundle-relative path conversion. Keeping a single copy guarantees the
//! tree walk, the index build, and full-text search agree on which files are
//! part of the Bundle.

use std::path::{Component, Path};

use ignore::WalkBuilder;

/// The canonical Bundle file walker: skips hidden files, honors the Bundle's
/// own `.gitignore`, and ignores global/parent gitignore so traversal depends
/// only on the Bundle's contents. Every traversal (tree, index, search) builds
/// from this so they cannot drift apart. Caller appends `.build()`.
pub fn bundle_walker(root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(true)
        .git_ignore(true)
        .git_global(false)
        .parents(false);
    builder
}

/// Walk the Bundle and yield every `.md` file as `(absolute path,
/// bundle-relative '/'-joined string)`. Built on [`bundle_walker`], so the
/// hidden/gitignore rules match the tree walk. Non-files, non-`.md` files, walk
/// errors, and the root itself (empty relative string) are skipped silently —
/// the single source of truth for "which `.md` files are part of the Bundle",
/// shared by the index build and full-text search.
pub(crate) fn md_files(root: &Path) -> impl Iterator<Item = (std::path::PathBuf, String)> + '_ {
    bundle_walker(root).build().filter_map(move |result| {
        let entry = result.ok()?;
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            return None;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            return None;
        }
        let rel = to_rel_string(path.strip_prefix(root).ok()?);
        if rel.is_empty() {
            return None;
        }
        Some((path.to_path_buf(), rel))
    })
}

/// Convert a path already relative to the Bundle root into a '/'-separated
/// bundle-relative string, dropping any non-`Normal` components.
pub fn to_rel_string(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

// --- Markdown link resolution -------------------------------------------------
//
// These mirror `src/lib/links.ts` on the frontend (the fake backend ports the
// same logic). They are shared by `index.rs` (extracting outbound links) and
// `rewrite.rs` (rewriting links on move/rename) so the two cannot diverge.

/// Index of the first `target` byte at or after `from`, if any.
pub fn find_byte(bytes: &[u8], from: usize, target: u8) -> Option<usize> {
    bytes[from..]
        .iter()
        .position(|&b| b == target)
        .map(|p| from + p)
}

/// Directory portion of a bundle-relative path ('' for a root-level file).
pub fn dir_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(slash) => &path[..slash],
        None => "",
    }
}

/// True for `scheme:`-prefixed URLs (http, https, mailto, tel, ...). Mirrors
/// the `SCHEME_RE` in `src/lib/links.ts`.
pub fn is_external(href: &str) -> bool {
    let bytes = href.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    for (i, &b) in bytes.iter().enumerate() {
        if b == b':' {
            return i > 0;
        }
        let ok = b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-');
        if !ok {
            return false;
        }
    }
    false
}

/// Collapse `.`/`..` segments. Leading `..` that would escape the root are
/// dropped (matching the backend's escape rejection and `links.ts`).
pub fn normalize_segments<'a>(segments: impl Iterator<Item = &'a str>) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in segments {
        match seg {
            "" | "." => continue,
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    out.join("/")
}

/// Resolve an `href` to a bundle-relative internal target, or `None` for
/// external / anchor / empty links. A trailing `#anchor` or `?query` is dropped
/// (so a path part already split of its suffix passes through unchanged).
/// Mirrors `resolveLink` in `src/lib/links.ts`.
pub fn resolve_internal(current_path: &str, href: &str) -> Option<String> {
    let raw = href.trim();
    if raw.is_empty() || is_external(raw) || raw.starts_with('#') {
        return None;
    }
    // Drop a trailing `#anchor` and `?query`.
    let path_part = raw.split('#').next().unwrap_or("");
    let path_part = path_part.split('?').next().unwrap_or("");
    if path_part.is_empty() {
        return None;
    }

    let path = if let Some(stripped) = path_part.strip_prefix('/') {
        // Bundle-absolute: resolve from the root.
        normalize_segments(stripped.split('/'))
    } else {
        // Relative: resolve against the current Concept's directory.
        let dir = dir_of(current_path);
        let dir_segments: Vec<&str> = if dir.is_empty() {
            Vec::new()
        } else {
            dir.split('/').collect()
        };
        normalize_segments(dir_segments.into_iter().chain(path_part.split('/')))
    };

    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_external_detects_scheme_urls() {
        assert!(is_external("http://example.com"));
        assert!(is_external("https://example.com"));
        assert!(is_external("mailto:a@b.c"));
        assert!(is_external("tel:123"));
        // Any `scheme:` with a non-empty alpha-led scheme counts.
        assert!(is_external("a+b-c.d:rest"));
        assert!(is_external("c:/windows/drive"));
    }

    #[test]
    fn is_external_rejects_non_schemes() {
        assert!(!is_external(""));
        assert!(!is_external("/absolute.md"));
        assert!(!is_external("./relative.md"));
        assert!(!is_external("bare.md"));
        assert!(!is_external("1leadingdigit:x")); // scheme must start alpha
        assert!(!is_external(":leadingcolon"));
        assert!(!is_external("has space:x")); // space is not a scheme char
    }

    #[test]
    fn dir_of_returns_parent_or_empty() {
        assert_eq!(dir_of("a/b/c.md"), "a/b");
        assert_eq!(dir_of("c.md"), "");
        assert_eq!(dir_of("a/b"), "a");
    }

    #[test]
    fn normalize_segments_collapses_dot_and_dotdot() {
        assert_eq!(normalize_segments(["a", ".", "b"].into_iter()), "a/b");
        assert_eq!(normalize_segments(["a", "..", "b"].into_iter()), "b");
        assert_eq!(normalize_segments(["", "a", "", "b"].into_iter()), "a/b");
        assert_eq!(normalize_segments(std::iter::empty()), "");
    }

    #[test]
    fn normalize_segments_drops_escaping_leading_dotdot() {
        // A leading `..` with nothing to pop is dropped (no root escape).
        assert_eq!(normalize_segments(["..", "a"].into_iter()), "a");
        assert_eq!(normalize_segments(["..", "..", "x.md"].into_iter()), "x.md");
    }

    #[test]
    fn resolve_internal_handles_relative_absolute_and_anchors() {
        // Relative: against the current Concept's directory.
        assert_eq!(
            resolve_internal("a/b.md", "c.md").as_deref(),
            Some("a/c.md")
        );
        assert_eq!(
            resolve_internal("dir/sub/b.md", "./x.md").as_deref(),
            Some("dir/sub/x.md")
        );
        assert_eq!(
            resolve_internal("a/b.md", "../c.md").as_deref(),
            Some("c.md")
        );
        // Root-level source resolves bare names at the root.
        assert_eq!(resolve_internal("b.md", "c.md").as_deref(), Some("c.md"));
        // Bundle-absolute: from the root, leading slash stripped.
        assert_eq!(
            resolve_internal("a/b.md", "/x/y.md").as_deref(),
            Some("x/y.md")
        );
        // Suffixes are dropped.
        assert_eq!(
            resolve_internal("a/b.md", "c.md#heading").as_deref(),
            Some("a/c.md")
        );
        assert_eq!(
            resolve_internal("a/b.md", "c.md?q=1").as_deref(),
            Some("a/c.md")
        );
    }

    #[test]
    fn resolve_internal_returns_none_for_non_targets() {
        assert_eq!(resolve_internal("a/b.md", ""), None);
        assert_eq!(resolve_internal("a/b.md", "   "), None);
        assert_eq!(resolve_internal("a/b.md", "http://x"), None);
        assert_eq!(resolve_internal("a/b.md", "#anchor-only"), None);
    }
}
