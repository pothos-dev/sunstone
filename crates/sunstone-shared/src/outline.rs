//! Markdown heading scan for the Outline (ADR 0006 family 13).
//!
//! The ONE source of truth for deriving a Concept's headings, folding the three
//! former twins: the editor's `outline.ts::scanHeadings` / `findHeadingLine`,
//! the fake backend's `fake/render.ts::headingMatch`, and the native
//! `render.rs::build_outline` node-walk. Native `render.rs` now calls
//! [`scan_headings`] on the RAW markdown for its SSR outline AND heading-id
//! injection, so the editor (wasm) and the SSR render enumerate headings by the
//! SAME algorithm.
//!
//! It is a **pure ATX string scan** (never a comrak parse — ADR 0006 §8, render
//! stays out of wasm): a line is a heading iff it is `#`…`######` + whitespace +
//! text, outside the leading YAML frontmatter block and outside fenced code
//! blocks. **Setext headings (`Foo\n===`) are NOT recognised** — the outline is
//! ATX-only on both sides (OKF/Obsidian-aligned; a deliberate ADR 0006 change).
//! Line numbers are 1-based against the FULL document (the frontmatter offset is
//! added back), so a click can scroll the editor to the exact line.

use serde::{Deserialize, Serialize};

use crate::frontmatter;
use crate::slug;

/// One outline entry: a markdown heading in document order (ADR 0006 §6 —
/// tsify-canonical; native `render.rs`'s `RenderPayload` re-points here). The
/// former editor `OutlineHeading` carried `line`; the former `render.rs` one
/// carried only `level`/`text`/`slug` — this unified shape carries all four
/// (the SSR render ignores `line`).
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineHeading {
    /// Heading level, 1 (`#`) … 6 (`######`). Drives indentation.
    pub level: u8,
    /// The heading text (the `#` markers and surrounding whitespace stripped).
    pub text: String,
    /// 1-based line number in the FULL document (frontmatter included).
    pub line: usize,
    /// GitHub-style anchor slug, de-duplicated in document order.
    pub slug: String,
}

/// The ATX heading `(level, text)` for `line`, or `None`. Mirrors the TS
/// `/^(#{1,6})\s+(.*)$/`: 1–6 leading `#`, then at least one whitespace char,
/// then the text (trimmed). Kept regex-free (ADR 0006 §2 — no `regex` crate).
fn atx_heading(line: &str) -> Option<(u8, String)> {
    let hashes = line.bytes().take_while(|&b| b == b'#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &line[hashes..];
    // The `\s+` requires at least one whitespace char after the hashes.
    if !rest.chars().next().is_some_and(|c| c.is_whitespace()) {
        return None;
    }
    Some((hashes as u8, rest.trim().to_string()))
}

/// The fence marker char (`` ` `` or `~`) opening/closing a fenced code block on
/// `line`, or `None`. Mirrors the TS `/^\s*(`{3,}|~{3,})/`: optional leading
/// whitespace, then a run of 3+ of the same backtick/tilde.
fn fence_marker(line: &str) -> Option<char> {
    let trimmed = line.trim_start();
    let first = trimmed.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let run = trimmed.chars().take_while(|&c| c == first).count();
    if run >= 3 {
        Some(first)
    } else {
        None
    }
}

/// Scan raw markdown for its body headings, in document order.
///
/// Skips the leading frontmatter block entirely (so a YAML `# comment` is never
/// an H1) and any line inside a fenced code block (so a `# comment` in a fence
/// is code, not a heading). Line numbers are 1-based against the FULL document,
/// so the frontmatter offset is added back to each body heading's line.
pub fn scan_headings(content: &str) -> Vec<OutlineHeading> {
    let body = frontmatter::split(content).body;
    let offset = frontmatter::frontmatter_line_count(content);

    let mut headings: Vec<OutlineHeading> = Vec::new();
    let mut in_fence = false;
    let mut fence_char = '\0';
    for (i, line) in body.split('\n').enumerate() {
        if let Some(marker) = fence_marker(line) {
            if !in_fence {
                in_fence = true;
                fence_char = marker;
            } else if marker == fence_char {
                // A closing fence must use the same marker as its opener.
                in_fence = false;
                fence_char = '\0';
            }
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some((level, text)) = atx_heading(line) {
            headings.push(OutlineHeading {
                level,
                text,
                line: offset + i + 1,
                slug: String::new(), // filled once the ordered list is known
            });
        }
    }
    // Slug de-duplication depends on document order, so assign in one pass over
    // the completed list.
    let slugs = slug::slugify_headings(&headings.iter().map(|h| h.text.clone()).collect::<Vec<_>>());
    for (h, s) in headings.iter_mut().zip(slugs) {
        h.slug = s;
    }
    headings
}

/// The full-document line of the first heading whose GitHub slug matches
/// `anchor`, or `None`. Both sides are slugged, so a modern `#deep-section` and
/// an older literal `#Deep Section` both resolve to `## Deep Section`.
pub fn find_heading_line(content: &str, anchor: &str) -> Option<usize> {
    let target = slug::slugify(anchor);
    scan_headings(content)
        .into_iter()
        .find(|h| h.slug == target)
        .map(|h| h.line)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn levels_texts_slugs(hs: &[OutlineHeading]) -> Vec<(u8, &str, &str)> {
        hs.iter()
            .map(|h| (h.level, h.text.as_str(), h.slug.as_str()))
            .collect()
    }

    #[test]
    fn scans_atx_headings_in_order_with_levels() {
        let hs = scan_headings("# One\n\ntext\n\n## Two\n\n### Three\n");
        assert_eq!(
            levels_texts_slugs(&hs),
            vec![(1, "One", "one"), (2, "Two", "two"), (3, "Three", "three")]
        );
    }

    #[test]
    fn lines_are_full_document_1_based() {
        let hs = scan_headings("# A\n## B\n");
        assert_eq!(hs[0].line, 1);
        assert_eq!(hs[1].line, 2);
    }

    #[test]
    fn frontmatter_offsets_body_lines_and_is_never_a_heading() {
        // The `# note` inside the YAML block is not an H1; the body H1 is line 4.
        let hs = scan_headings("---\ntitle: # note\n---\n# Body\n");
        assert_eq!(hs.len(), 1);
        assert_eq!(hs[0].text, "Body");
        assert_eq!(hs[0].line, 4);
    }

    #[test]
    fn fenced_code_headings_are_skipped() {
        let hs = scan_headings("# Real\n\n```\n# not a heading\n```\n\n## Also Real\n");
        assert_eq!(
            levels_texts_slugs(&hs),
            vec![(1, "Real", "real"), (2, "Also Real", "also-real")]
        );
    }

    #[test]
    fn tilde_fence_and_mismatched_marker() {
        // A ``` inside a ~~~ fence does not close it.
        let hs = scan_headings("~~~\n# in tilde fence\n```\n# still in fence\n~~~\n# Out\n");
        assert_eq!(levels_texts_slugs(&hs), vec![(1, "Out", "out")]);
    }

    #[test]
    fn seven_hashes_is_not_a_heading() {
        assert!(scan_headings("####### too many\n").is_empty());
    }

    #[test]
    fn hash_without_space_is_not_a_heading() {
        assert!(scan_headings("#nospace\n").is_empty());
    }

    #[test]
    fn setext_headings_are_not_recognised() {
        // ATX-only (ADR 0006): `Foo\n===` / `Bar\n---` are NOT headings.
        assert!(scan_headings("Foo\n===\n\nBar\n---\n").is_empty());
    }

    #[test]
    fn duplicate_headings_get_deduped_slugs() {
        let hs = scan_headings("# Notes\n## Notes\n");
        assert_eq!(hs[0].slug, "notes");
        assert_eq!(hs[1].slug, "notes-1");
    }

    #[test]
    fn find_heading_line_matches_by_slug_both_forms() {
        let content = "# Intro\n\n## Deep Section\n";
        assert_eq!(find_heading_line(content, "deep-section"), Some(3));
        assert_eq!(find_heading_line(content, "Deep Section"), Some(3));
        assert_eq!(find_heading_line(content, "missing"), None);
    }
}
