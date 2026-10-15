//! Outbound markdown-link extraction for the Bundle index.
//!
//! Finds every markdown link href in a Concept body and keeps it RAW. A
//! bundle-absolute href (`/x.md`) resolves against the detected Bundle root,
//! which depends on every path in the Bundle, so resolution cannot happen per
//! Concept at insert time: `Index::rebuild_reverse` resolves each href through
//! `sunstone_shared::links::resolve_link` once it has the whole Concept set
//! and the root (ov-20) — the same call the frontend's wasm `resolveLinkIn`
//! makes, so native and fake Backlinks agree.

use std::collections::BTreeSet;

use crate::index::frontmatter::strip_frontmatter;
use sunstone_shared::scan::markdown_link_hrefs;

/// Extract every markdown link href from a Concept body, unresolved (trimmed,
/// de-duplicated and sorted for stability). External, pure-anchor and empty
/// hrefs are kept here and dropped by the resolver in `rebuild_reverse`.
/// Reference-style links are out of scope (the fixtures and OKF Concepts use
/// inline links).
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
/// `rewrite_links_in` (site 2), the TS fake's extraction twin
/// `src/lib/ipc/fake/links.ts::outboundLinks` (site 3), and the module note in
/// `sunstone-shared/src/embed.rs`.
pub(super) fn extract_link_hrefs(content: &str) -> Vec<String> {
    let body = strip_frontmatter(content);
    let out: BTreeSet<String> = markdown_link_hrefs(body)
        .into_iter()
        .map(|href| href.trim().to_string())
        .filter(|href| !href.is_empty())
        .collect();
    out.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_hrefs_raw_for_the_root_aware_resolver() {
        // Relative and bundle-absolute hrefs stay as written: only
        // `rebuild_reverse` knows the Bundle root they resolve against.
        let body = "[a](./a.md) [b](/b.md) [c](../c.md#h) [a again](./a.md)";
        assert_eq!(
            extract_link_hrefs(body),
            vec!["../c.md#h", "./a.md", "/b.md"]
        );
    }

    #[test]
    fn extracts_links_skipping_images() {
        let body = "See [A](./a.md) and ![img](./pic.png) and [ext](https://x).";
        assert_eq!(extract_link_hrefs(body), vec!["./a.md", "https://x"]);
    }

    #[test]
    fn an_embed_of_a_concept_still_creates_no_edge() {
        // The extraction half of the af-1 asymmetry, pinned: even when an Embed
        // target IS a Concept path, it contributes no link (hence no backlink).
        // The rewrite half deliberately behaves the OTHER way.
        let links = extract_link_hrefs("![x](/b.md) ![[c.png]] [real](/b.md)");
        assert_eq!(links, vec!["/b.md"]);
    }

    #[test]
    fn frontmatter_is_not_scanned() {
        let links = extract_link_hrefs("---\nsee: \"[x](/x.md)\"\n---\n[y](/y.md)\n");
        assert_eq!(links, vec!["/y.md"]);
    }
}
