//! Leading YAML frontmatter parsing for the Bundle index.
//!
//! The pure kernels now live once in [`sunstone_shared::frontmatter`] (ADR 0006
//! family 11) — the single source shared with the wasm frontend. This module
//! only re-points the index's callers there: it re-exports the aggregate parse
//! ([`parse_frontmatter`] / [`ParsedFrontmatter`]) and keeps the thin
//! `strip_frontmatter` slice helper the link extractor reuses. The Properties
//! panel owns verbatim round-tripping (TS); broken/invalid frontmatter is
//! tolerated, never blocked (docs/GLOSSARY.md).

pub use sunstone_shared::frontmatter::{parse_frontmatter, ParsedFrontmatter};

/// Strip the leading frontmatter block so a `---` or link-like text inside it is
/// not mistaken for body content. Returns the whole content when there is no
/// block. A thin native-facing slice over [`sunstone_shared::frontmatter::split`].
pub fn strip_frontmatter(content: &str) -> &str {
    sunstone_shared::frontmatter::split(content).body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_type_and_tags() {
        let md = "---\ntype: concept\ntags: [a, b]\n---\n\n# Body\n";
        let fm = parse_frontmatter(md);
        assert_eq!(fm.concept_type.as_deref(), Some("concept"));
        assert_eq!(fm.tags, vec!["a", "b"]);
        assert_eq!(fm.keys, vec!["type", "tags"]);
    }

    #[test]
    fn tolerates_missing_frontmatter() {
        let fm = parse_frontmatter("# Just a body, no frontmatter\n");
        assert!(fm.concept_type.is_none());
        assert!(fm.tags.is_empty());
        assert!(fm.keys.is_empty());
    }

    #[test]
    fn tolerates_empty_type() {
        let fm = parse_frontmatter("---\ntype:\ntitle: x\n---\n");
        assert!(fm.concept_type.is_none());
        // Even when `type` is empty, its KEY is still present (autocomplete).
        assert_eq!(fm.keys, vec!["type", "title"]);
    }

    #[test]
    fn strip_removes_a_normal_frontmatter_block() {
        assert_eq!(
            strip_frontmatter("---\ntype: concept\n---\n# Body\n"),
            "# Body\n"
        );
    }

    #[test]
    fn strip_removes_an_empty_frontmatter_block() {
        // An empty block (`---\n---\n`) must not leak its closing fence into the
        // body — the body here is just "x\n".
        assert_eq!(strip_frontmatter("---\n---\nx\n"), "x\n");
    }

    #[test]
    fn strip_passes_through_content_without_frontmatter() {
        assert_eq!(strip_frontmatter("# Body\n---\nx\n"), "# Body\n---\nx\n");
    }

    #[test]
    fn strip_handles_a_closing_fence_with_no_trailing_newline() {
        // Body is empty when the file ends right after the closing fence.
        assert_eq!(strip_frontmatter("---\ntype: x\n---"), "");
    }
}
