//! Native Bundle filesystem-walk helpers.
//!
//! The `ignore`-backed walker (`bundle_walker` / `md_files`) is native-only and
//! stays here; the pure bundle-path math it once shared with the frontend
//! (`find_byte`, `resolve_internal`, `is_external`, `dir_of`, `normalize_segments`,
//! `to_rel_string`) moved to `sunstone-shared::paths` (ADR 0006 §2, family 10).
//! Call sites now import those from the shared crate directly.

use std::path::Path;

use ignore::WalkBuilder;
use sunstone_shared::paths::to_rel_string;

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
