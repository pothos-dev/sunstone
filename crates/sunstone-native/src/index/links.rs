//! Outbound markdown-link extraction for the Bundle index.
//!
//! Finds every internal markdown link target in a Concept body and resolves it
//! to a bundle-relative path via `sunstone_shared::paths::resolve_location`
//! (external `scheme:`, pure-anchor, and empty links are ignored) — the same
//! resolver the frontend runs through wasm, so its broken-link decoration can
//! trust the Rust index. A folder target (`""` for the Bundle root) is kept as
//! the folder; `Index::rebuild_reverse`, which has the Concept set, maps it
//! onto the folder's `index.md`.

use std::collections::BTreeSet;

use crate::index::frontmatter::strip_frontmatter;
use sunstone_shared::paths::resolve_location;
use sunstone_shared::scan::markdown_link_hrefs;

/// Extract all internal markdown link targets from a Concept body, resolved to
/// bundle-relative paths (a folder link resolves to the folder, `""` for the
/// Bundle root). External (`scheme:`), pure-anchor, and empty links are
/// skipped. De-duplicated and sorted for stability. Reference-style links are
/// out of scope (the fixtures and OKF Concepts use inline links).
///
/// The links come from [`markdown_link_hrefs`], the shared scan the move/rename
/// engine rewrites over, so an edge exists exactly where a move would rewrite
/// the link: a link in a fenced code block is no edge, one in an inline code
/// span is (the markdown-link half of the scanner is code-agnostic).
///
/// # The `!`-asymmetry is DELIBERATE (af-1) — site 1 of 3
///
/// EXTRACTION drops `!` (`markdown_link_hrefs` skips Embeds); REWRITE
/// (`sunstone-shared/src/rewrite/moves.rs::rewrite_links_in`) does not. Do not
/// "restore symmetry" here: an Embed is not a Concept-to-Concept relationship,
/// so it must never create a Backlinks edge — which is what this drop
/// guarantees. That an Embed's *path* is still rewritten on a move is a
/// different question with a different answer; see the twin comment in
/// `rewrite_links_in` and the module note in `sunstone-shared/src/embed.rs`.
pub(super) fn extract_links(current_path: &str, content: &str) -> Vec<String> {
    let body = strip_frontmatter(content);
    let mut out: BTreeSet<String> = BTreeSet::new();
    for href in markdown_link_hrefs(body) {
        if let Some(target) = resolve_location(current_path, &href) {
            out.insert(target);
        }
    }
    out.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sunstone_shared::paths::resolve_internal;

    #[test]
    fn resolves_relative_and_absolute_links() {
        assert_eq!(
            resolve_internal("concepts/bundle.md", "./codemirror.md").as_deref(),
            Some("concepts/codemirror.md")
        );
        assert_eq!(
            resolve_internal("concepts/bundle.md", "/index.md").as_deref(),
            Some("index.md")
        );
        assert_eq!(
            resolve_internal("a/b/c.md", "../x.md").as_deref(),
            Some("a/x.md")
        );
    }

    #[test]
    fn ignores_external_and_anchor_links() {
        assert!(resolve_internal("a.md", "https://example.com").is_none());
        assert!(resolve_internal("a.md", "mailto:x@y.z").is_none());
        assert!(resolve_internal("a.md", "#section").is_none());
        assert!(resolve_internal("a.md", "").is_none());
    }

    #[test]
    fn extracts_links_skipping_images() {
        let body = "See [A](./a.md) and ![img](./pic.png) and [ext](https://x).";
        let links = extract_links("dir/cur.md", body);
        assert_eq!(links, vec!["dir/a.md"]);
    }

    #[test]
    fn an_embed_of_a_concept_still_creates_no_edge() {
        // The extraction half of the af-1 asymmetry, pinned: even when an Embed
        // target IS a Concept path, it contributes no link (hence no backlink).
        // The rewrite half deliberately behaves the OTHER way.
        let links = extract_links("a.md", "![x](/b.md) ![[c.png]] [real](/b.md)");
        assert_eq!(links, vec!["b.md"]);
    }
}
