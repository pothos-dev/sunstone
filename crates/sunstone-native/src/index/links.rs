//! Outbound markdown-link extraction for the Bundle index.
//!
//! Finds every internal markdown link target in a Concept body and resolves it
//! to a bundle-relative path. Mirrors `src/lib/links.ts` EXACTLY (external
//! `scheme:`, pure-anchor, and empty links are ignored), so the frontend's
//! broken-link decoration can trust the Rust index.

use std::collections::BTreeSet;

use crate::index::frontmatter::strip_frontmatter;
use crate::paths::{find_byte, resolve_internal};

/// Extract all internal markdown link targets from a Concept body, resolved to
/// bundle-relative paths. External (`scheme:`), pure-anchor, and empty links are
/// skipped. De-duplicated, insertion order preserved-ish (sorted for stability).
pub(super) fn extract_links(current_path: &str, content: &str) -> Vec<String> {
    let body = strip_frontmatter(content);
    let mut out: BTreeSet<String> = BTreeSet::new();
    for href in markdown_link_hrefs(body) {
        if let Some(target) = resolve_internal(current_path, &href) {
            out.insert(target);
        }
    }
    out.into_iter().collect()
}

/// Find every markdown inline-link `href`: the `target` in `[text](target)`.
/// Image links `![alt](src)` are skipped (images are not Concept links).
/// Handles a trailing `"title"` inside the parens. Reference-style links are
/// out of scope (the fixtures and OKF Concepts use inline links).
fn markdown_link_hrefs(body: &str) -> Vec<String> {
    let bytes = body.as_bytes();
    let mut hrefs = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            // Skip image links: a `!` immediately before `[`.
            let is_image = i > 0 && bytes[i - 1] == b'!';
            // Find the matching `]` (no nested brackets in OKF link text).
            if let Some(close) = find_byte(bytes, i + 1, b']') {
                // Must be immediately followed by `(`.
                if close + 1 < bytes.len() && bytes[close + 1] == b'(' {
                    if let Some(paren) = find_byte(bytes, close + 2, b')') {
                        if !is_image {
                            let raw = &body[close + 2..paren];
                            hrefs.push(extract_href(raw));
                        }
                        i = paren + 1;
                        continue;
                    }
                }
                i = close + 1;
                continue;
            }
        }
        i += 1;
    }
    hrefs
}

/// From the inside of a link's parens (`target "title"`), return just the
/// target (drop a trailing title and surrounding whitespace / angle brackets).
fn extract_href(raw: &str) -> String {
    let trimmed = raw.trim();
    // A title is ` "..."` or ` '...'` after the URL.
    let url = trimmed
        .split_once(char::is_whitespace)
        .map(|(u, _)| u)
        .unwrap_or(trimmed);
    url.trim_matches(['<', '>']).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::resolve_internal;

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
}
