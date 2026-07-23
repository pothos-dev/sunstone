//! Anchor-rewrite: when a heading's slug changes in the editor, rewrite every
//! inbound link's ANCHOR across the bundle so `[[Page#old-slug]]` becomes
//! `[[Page#new-slug]]` and `[text](/page.md#old-slug)` becomes
//! `[text](/page.md#new-slug)`.
//!
//! This is the sibling of the rename-rewrite engine (`engine.rs`): it uses the
//! same byte-by-byte scanner (skipping fenced / inline code, embeds, images) but
//! touches ONLY the anchor of links that (a) resolve to the renamed `target` and
//! (b) whose current anchor SLUG matches a rename's old slug. The link's path /
//! name / alias and every other link are left byte-for-byte unchanged.
//!
//! Because both sides are slugged (`slug::slugify`), an older literal anchor
//! (`[[p#Deep Section]]`) matches a rename `from: "deep-section"` and is migrated
//! to the canonical slug on the first heading change.
//!
//! Pure module logic (no IO / index) so it is exhaustively unit-testable; the
//! orchestration in `rewrite.rs` reads/writes files and drives it.

use serde::Deserialize;

use crate::paths::{find_byte, is_external, resolve_internal};
use crate::slug::slugify;
use crate::wikilink::{self, find_double_close, parse_target};

use super::paths::{split_suffix, utf8_len};

/// One heading-slug rename: the old slug (`from`) and the new slug (`to`). Sent
/// from the editor, which tracks each heading's identity across edits and emits a
/// rename when a heading's slug changes. Matches the TS `{ from, to }`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorRename {
    pub from: String,
    pub to: String,
}

/// The new slug for an anchor whose CURRENT slug matches a rename's `from`, or
/// `None` when no rename applies.
fn new_anchor_for<'a>(anchor: &str, renames: &'a [AnchorRename]) -> Option<&'a str> {
    let slug = slugify(anchor);
    renames.iter().find(|r| r.from == slug).map(|r| r.to.as_str())
}

/// Rewrite every anchor in `content` that points at a renamed heading in
/// `target`. `source` is the concept `content` lives at (resolution base);
/// `all_paths` is the bundle's concept path set (for name-based wikilink
/// resolution). Returns the rewritten content and the count of anchors changed.
pub fn rewrite_anchors_in(
    source: &str,
    content: &str,
    target: &str,
    renames: &[AnchorRename],
    all_paths: &[String],
) -> (String, usize) {
    let mut out = String::with_capacity(content.len());
    let mut count = 0usize;
    let bytes = content.as_bytes();
    let mut i = 0usize;
    let mut in_inline_code = false;
    let mut fence: Option<u8> = None;
    let mut at_line_start = true;

    while i < bytes.len() {
        // --- Fenced code blocks (line-start ``` / ~~~) — copied verbatim ----
        if at_line_start {
            let mut j = i;
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                j += 1;
            }
            if j + 2 < bytes.len()
                && (bytes[j] == b'`' || bytes[j] == b'~')
                && bytes[j + 1] == bytes[j]
                && bytes[j + 2] == bytes[j]
            {
                let ch = bytes[j];
                match fence {
                    Some(f) if f == ch => fence = None,
                    None => fence = Some(ch),
                    _ => {}
                }
                let line_end = find_byte(bytes, i, b'\n').map(|p| p + 1).unwrap_or(bytes.len());
                out.push_str(&content[i..line_end]);
                i = line_end;
                at_line_start = true;
                continue;
            }
        }

        // --- Wikilink `[[ ... ]]` --------------------------------------------
        if fence.is_none()
            && !in_inline_code
            && bytes[i] == b'['
            && i + 1 < bytes.len()
            && bytes[i + 1] == b'['
        {
            let is_embed = i > 0 && bytes[i - 1] == b'!';
            if let Some(close) = find_double_close(bytes, i + 2) {
                let raw = &content[i + 2..close];
                let replacement = if is_embed {
                    None
                } else {
                    rewrite_wikilink_anchor(source, raw, target, renames, all_paths)
                };
                out.push_str("[[");
                match replacement {
                    Some(new_raw) => {
                        out.push_str(&new_raw);
                        count += 1;
                    }
                    None => out.push_str(raw),
                }
                out.push_str("]]");
                i = close + 2;
                at_line_start = false;
                continue;
            }
        }

        if bytes[i] == b'`' && fence.is_none() {
            in_inline_code = !in_inline_code;
        }

        // --- Markdown link `[text](target#anchor)` ---------------------------
        if fence.is_none() && bytes[i] == b'[' {
            let is_image = i > 0 && bytes[i - 1] == b'!';
            if let Some(close) = find_byte(bytes, i + 1, b']') {
                if close + 1 < bytes.len() && bytes[close + 1] == b'(' {
                    if let Some(paren) = find_byte(bytes, close + 2, b')') {
                        let inner = &content[close + 2..paren];
                        let new_inner = if is_image {
                            None
                        } else {
                            rewrite_md_anchor(source, inner, target, renames)
                        };
                        out.push_str(&content[i..close + 2]);
                        match new_inner {
                            Some(replacement) => {
                                out.push_str(&replacement);
                                count += 1;
                            }
                            None => out.push_str(inner),
                        }
                        out.push(')');
                        i = paren + 1;
                        at_line_start = false;
                        continue;
                    }
                }
            }
        }

        at_line_start = bytes[i] == b'\n';
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&content[i..i + ch_len]);
        i += ch_len;
    }

    (out, count)
}

/// Rewrite a wikilink's anchor if it resolves to `target` and its slug was
/// renamed. Preserves the name, the alias, and the delimiter layout — only the
/// anchor text between `#` and the next `|` (or the end) is replaced.
fn rewrite_wikilink_anchor(
    source: &str,
    raw: &str,
    target: &str,
    renames: &[AnchorRename],
    all_paths: &[String],
) -> Option<String> {
    let parsed = parse_target(raw);
    let anchor = parsed.anchor.as_deref()?;
    if anchor.trim().is_empty() {
        return None;
    }
    // The link must point at the concept whose headings changed. (Pure same-file
    // anchors resolve to `source`, which the orchestrator excludes from the
    // rewrite set — those are handled in the open editor buffer.)
    if wikilink::resolve_wikilink(all_paths, source, raw)? != target {
        return None;
    }
    let new_anchor = new_anchor_for(anchor, renames)?;

    // Replace ONLY the anchor text (between the first `#` and the next `|`).
    let h = raw.find('#')?;
    let after = &raw[h + 1..];
    let anchor_end = after.find('|').unwrap_or(after.len());
    let rebuilt = format!("{}#{}{}", &raw[..h], new_anchor, &after[anchor_end..]);
    if rebuilt == raw {
        return None;
    }
    Some(rebuilt)
}

/// Rewrite a markdown link's `#anchor` if the link resolves to `target` and its
/// anchor slug was renamed. Mirrors `engine::rewrite_target`'s parsing of the
/// `(...)` inner text (leading ws, optional `<...>`, trailing "title"); only the
/// anchor within the URL's suffix is touched, the path is preserved.
fn rewrite_md_anchor(
    source: &str,
    inner: &str,
    target: &str,
    renames: &[AnchorRename],
) -> Option<String> {
    let leading_ws_len = inner.len() - inner.trim_start().len();
    let leading = &inner[..leading_ws_len];
    let rest = &inner[leading_ws_len..];

    let (url_raw, title) = match rest.find(char::is_whitespace) {
        Some(p) => (&rest[..p], &rest[p..]),
        None => (rest, ""),
    };
    if url_raw.is_empty() {
        return None;
    }
    let (angle_open, url_core, angle_close) = if url_raw.starts_with('<') && url_raw.ends_with('>') {
        ("<", &url_raw[1..url_raw.len() - 1], ">")
    } else {
        ("", url_raw, "")
    };
    if is_external(url_core) || url_core.starts_with('#') {
        // External links, and pure same-file anchors (handled in the buffer),
        // are out of scope here.
        return None;
    }

    let (path_part, suffix) = split_suffix(url_core);
    if path_part.is_empty() || !suffix.starts_with('#') {
        return None;
    }
    // The anchor is the `#...` up to an optional `?query`.
    let anchor_end = suffix[1..]
        .find('?')
        .map(|p| p + 1)
        .unwrap_or(suffix.len());
    let anchor = &suffix[1..anchor_end];
    let tail = &suffix[anchor_end..];

    if resolve_internal(source, path_part)? != target {
        return None;
    }
    let new_anchor = new_anchor_for(anchor, renames)?;
    let new_url = format!("{path_part}#{new_anchor}{tail}");
    Some(format!("{leading}{angle_open}{new_url}{angle_close}{title}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(ps: &[&str]) -> Vec<String> {
        ps.iter().map(|s| s.to_string()).collect()
    }

    fn renames(pairs: &[(&str, &str)]) -> Vec<AnchorRename> {
        pairs
            .iter()
            .map(|(f, t)| AnchorRename {
                from: f.to_string(),
                to: t.to_string(),
            })
            .collect()
    }

    #[test]
    fn rewrites_bare_wikilink_anchor_to_target() {
        let all = paths(&["a.md", "target.md"]);
        let (out, n) = rewrite_anchors_in(
            "a.md",
            "see [[target#deep-section]] here",
            "target.md",
            &renames(&[("deep-section", "deeper-section")]),
            &all,
        );
        assert_eq!(out, "see [[target#deeper-section]] here");
        assert_eq!(n, 1);
    }

    #[test]
    fn preserves_alias_when_swapping_anchor() {
        let all = paths(&["a.md", "target.md"]);
        // Anchor before alias.
        let (out, n) = rewrite_anchors_in(
            "a.md",
            "[[target#old|Label]]",
            "target.md",
            &renames(&[("old", "new")]),
            &all,
        );
        assert_eq!(out, "[[target#new|Label]]");
        assert_eq!(n, 1);
    }

    #[test]
    fn migrates_literal_anchor_to_slug() {
        // An older literal anchor `#Deep Section` slugs to `deep-section` and is
        // rewritten to the canonical new slug.
        let all = paths(&["a.md", "target.md"]);
        let (out, n) = rewrite_anchors_in(
            "a.md",
            "[[target#Deep Section]]",
            "target.md",
            &renames(&[("deep-section", "intro")]),
            &all,
        );
        assert_eq!(out, "[[target#intro]]");
        assert_eq!(n, 1);
    }

    #[test]
    fn leaves_anchors_to_other_targets_untouched() {
        let all = paths(&["a.md", "target.md", "other.md"]);
        let (out, n) = rewrite_anchors_in(
            "a.md",
            "[[other#deep-section]] and [[target#deep-section]]",
            "target.md",
            &renames(&[("deep-section", "x")]),
            &all,
        );
        assert_eq!(out, "[[other#deep-section]] and [[target#x]]");
        assert_eq!(n, 1);
    }

    #[test]
    fn leaves_non_matching_slug_untouched() {
        let all = paths(&["a.md", "target.md"]);
        let (out, n) = rewrite_anchors_in(
            "a.md",
            "[[target#other-heading]]",
            "target.md",
            &renames(&[("deep-section", "x")]),
            &all,
        );
        assert_eq!(out, "[[target#other-heading]]");
        assert_eq!(n, 0);
    }

    #[test]
    fn rewrites_markdown_link_anchor() {
        let all = paths(&["a.md", "target.md"]);
        let (out, n) = rewrite_anchors_in(
            "a.md",
            "See [it](/target.md#old) now.",
            "target.md",
            &renames(&[("old", "new")]),
            &all,
        );
        assert_eq!(out, "See [it](/target.md#new) now.");
        assert_eq!(n, 1);
    }

    #[test]
    fn markdown_anchor_preserves_query_and_title() {
        let all = paths(&["a.md", "target.md"]);
        let (out, n) = rewrite_anchors_in(
            "a.md",
            "[it](/target.md#old?x=1 \"Title\")",
            "target.md",
            &renames(&[("old", "new")]),
            &all,
        );
        assert_eq!(out, "[it](/target.md#new?x=1 \"Title\")");
        assert_eq!(n, 1);
    }

    #[test]
    fn skips_code_and_embeds() {
        let all = paths(&["a.md", "target.md"]);
        let body = "real [[target#old]]\n```\ncode [[target#old]]\n```\n\
                    inline `[[target#old]]` and embed ![[target#old]]";
        let (out, n) = rewrite_anchors_in(
            "a.md",
            body,
            "target.md",
            &renames(&[("old", "new")]),
            &all,
        );
        assert_eq!(
            out,
            "real [[target#new]]\n```\ncode [[target#old]]\n```\n\
             inline `[[target#old]]` and embed ![[target#old]]"
        );
        assert_eq!(n, 1);
    }
}
