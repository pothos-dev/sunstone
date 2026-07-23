//! Wikilink (`[[name]]`) parsing and NAME-based resolution.
//!
//! Wikilinks are an OPTIONAL, SECONDARY link format (see
//! `docs/adr/0004-wikilinks-optional-secondary-name-based.md` and the
//! **Wikilink** term in `docs/GLOSSARY.md`). Standard markdown links remain primary
//! and resolve by PATH (`paths::resolve_internal`); wikilinks resolve by NAME —
//! a fundamentally different model. The governing rule is **match Obsidian
//! exactly**, since the `[[ ]]` links originate from Obsidian vaults.
//!
//! This module is the single source of truth for both behaviours that consume
//! wikilinks in the Rust backend: outbound-link extraction / backlinks
//! (`index.rs`) and rename-rewrite (`rewrite.rs`). The TS fake backend
//! (`src/lib/links.ts`) mirrors `resolve_wikilink` EXACTLY so the editor's
//! broken-link decoration can trust this index.

use crate::paths::find_byte;

/// The three pieces of a raw `[[ ... ]]` inner text: the name used for file
/// matching (with any `.md` extension dropped), an optional `|alias` display
/// text, and an optional `#anchor`. The alias and anchor never participate in
/// file resolution (Obsidian rule) — they are preserved for rename-rewrite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiTarget {
    /// File-match portion (trimmed, `.md` dropped). May be empty for a pure
    /// same-file anchor like `[[#heading]]`.
    pub name: String,
    /// `|alias` display text WITHOUT the leading `|`, if present.
    pub alias: Option<String>,
    /// `#anchor` WITHOUT the leading `#`, if present.
    pub anchor: Option<String>,
}

/// Split a raw `[[ ... ]]` inner text into `{ name, alias, anchor }`.
///
/// The alias begins at the first `|`; the anchor at the first `#`. Whichever
/// comes first bounds the name (Obsidian accepts both `[[name#anchor|alias]]`
/// and `[[name|alias#anchor]]`; we split on the earliest delimiter so the name
/// is always the leading filename part). A trailing `.md` (case-insensitive) on
/// the name is dropped to match the algorithm in the shared spec.
/// Byte offset where a wikilink's NAME portion ends: the earliest of the first
/// `|` (alias) or first `#` (anchor), or the whole string when neither is
/// present. Shared by [`parse_target`] and the rename rewriter so the two agree
/// on exactly where the name ends.
pub(crate) fn name_end(raw: &str) -> usize {
    match (raw.find('|'), raw.find('#')) {
        (Some(p), Some(h)) => p.min(h),
        (Some(p), None) => p,
        (None, Some(h)) => h,
        (None, None) => raw.len(),
    }
}

pub fn parse_target(raw: &str) -> WikiTarget {
    // Locate the first `|` and the first `#`; the name ends at the earliest.
    let pipe = raw.find('|');
    let hash = raw.find('#');
    // Drop a trailing `.md` (case-insensitive) — `[[name.md]]` is accepted.
    let name = drop_md(raw[..name_end(raw)].trim()).trim().to_string();

    // Alias = text after the FIRST `|`, up to (but not including) a `#` that
    // follows it. Anchor = text after the FIRST `#`.
    let alias = pipe.map(|p| {
        let after = &raw[p + 1..];
        let end = after.find('#').unwrap_or(after.len());
        after[..end].to_string()
    });
    let anchor = hash.map(|h| {
        let after = &raw[h + 1..];
        // If a `|` follows the `#`, the anchor stops there.
        let end = after.find('|').unwrap_or(after.len());
        after[..end].to_string()
    });

    WikiTarget {
        name,
        alias,
        anchor,
    }
}

/// Strip the trailing `.md` (case-insensitive) from a bundle path / basename.
pub(crate) fn drop_md(s: &str) -> &str {
    if s.len() >= 3 && s[s.len() - 3..].eq_ignore_ascii_case(".md") {
        &s[..s.len() - 3]
    } else {
        s
    }
}

/// The basename of a '/'-separated bundle path (the part after the last `/`).
pub(crate) fn basename(path: &str) -> &str {
    match path.rfind('/') {
        Some(slash) => &path[slash + 1..],
        None => path,
    }
}

/// Resolve a wikilink target to a bundle path, or `None` if unresolved
/// (broken). MUST be identical to `resolveWikilink` in `src/lib/links.ts` and
/// the shared spec's §1 algorithm.
///
/// * `all_paths`: every concept `.md` path in the bundle (bundle-relative, no
///   leading slash).
/// * `source_path`: the concept the link is written in (for `[[#anchor]]`).
/// * `raw`: the inner text of `[[ ... ]]` (may include `|alias` / `#anchor`).
///
/// Matching is case-insensitive and LITERAL (no slug/space normalization).
/// A bare name matches by basename; a partial path (`folder/name`) matches by
/// path suffix. Ambiguity is resolved SILENTLY: shortest path (fewest `/`),
/// then lexicographically. A pure same-file anchor (`[[#heading]]`, empty after
/// stripping) resolves to `source_path` itself.
pub fn resolve_wikilink(all_paths: &[String], source_path: &str, raw: &str) -> Option<String> {
    let target = parse_target(raw);
    let t = target.name.trim();
    if t.is_empty() {
        // Pure same-file anchor: `[[#heading]]`.
        return Some(source_path.to_string());
    }
    let lower = t.to_ascii_lowercase();
    let has_slash = t.contains('/');

    let mut matches: Vec<&String> = all_paths
        .iter()
        .filter(|c| c.to_ascii_lowercase().ends_with(".md"))
        .filter(|c| {
            let no_ext = drop_md(c).to_ascii_lowercase();
            if has_slash {
                // Partial path -> suffix match (full equality or `/`-bounded).
                no_ext == lower || no_ext.ends_with(&format!("/{lower}"))
            } else {
                // Bare name -> basename match.
                drop_md(basename(c)).to_ascii_lowercase() == lower
            }
        })
        .collect();

    if matches.is_empty() {
        return None;
    }
    // Tie-break: fewest `/` (shortest path), then lexicographically.
    matches.sort_by(|a, b| {
        let sa = a.matches('/').count();
        let sb = b.matches('/').count();
        sa.cmp(&sb).then_with(|| a.cmp(b))
    });
    Some(matches[0].clone())
}

/// Scan a Concept body for every wikilink inner text (`[[ ... ]]`), skipping
/// fenced code blocks (``` / ~~~) and inline code spans (`` ` ``), exactly as
/// the markdown-link scanner does. Returns the RAW inner texts (alias/anchor
/// included) for the caller to resolve via [`resolve_wikilink`].
///
/// NOTE: embeds (`![[ ... ]]`, a leading `!`) are OUT OF SCOPE for v1 and are
/// skipped here, the same way `![](...)` images are skipped by the markdown
/// scanner. Embed support is DEFERRED to a later phase.
pub fn wikilink_raws(body: &str) -> Vec<String> {
    let bytes = body.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    // Tracks the active inline-code / fenced-code state so `[[`s inside code are
    // ignored (matching the spec's "do not parse inside code").
    let mut in_inline_code = false;
    let mut fence: Option<u8> = None; // Some(b'`') or Some(b'~') when in a fence.
    let mut at_line_start = true;

    while i < bytes.len() {
        let b = bytes[i];

        // Fenced code blocks: a line beginning (after optional spaces) with
        // ``` or ~~~ toggles the fence. We only honour the opener/closer at a
        // line start, like CommonMark fences.
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
                    Some(f) if f == ch => fence = None, // closing fence
                    None => fence = Some(ch),           // opening fence
                    _ => {}                              // a different fence char inside; ignore
                }
                // Skip to end of this line.
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                at_line_start = true;
                continue;
            }
        }

        if fence.is_some() {
            at_line_start = b == b'\n';
            i += 1;
            continue;
        }

        if b == b'`' {
            // Toggle inline code. (Single backtick spans; the OKF/Obsidian
            // content does not nest multi-backtick spans around wikilinks.)
            in_inline_code = !in_inline_code;
            at_line_start = false;
            i += 1;
            continue;
        }

        if !in_inline_code && b == b'[' && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            // Skip embeds: a `!` immediately before `[[`.
            let is_embed = i > 0 && bytes[i - 1] == b'!';
            // Find the first closing `]]`.
            if let Some(close) = find_double_close(bytes, i + 2) {
                if !is_embed {
                    out.push(body[i + 2..close].to_string());
                }
                i = close + 2;
                at_line_start = false;
                continue;
            }
        }

        at_line_start = b == b'\n';
        i += 1;
    }

    out
}

/// Rewrite every wikilink (`[[ ... ]]`) in a Concept body, leaving code spans /
/// fenced blocks / embeds untouched. For each non-embed wikilink the callback
/// `f` receives the RAW inner text (alias/anchor included) and returns the
/// replacement text spliced in place of the whole `[[ ... ]]`. Everything else
/// (including embeds `![[ ... ]]` and any `[[ ... ]]` inside code) is copied
/// verbatim.
///
/// This shares the exact scanning contract of [`wikilink_raws`] — the two agree
/// on which spans are wikilinks (guarded by a test) — so the server-side render
/// (which converts `[[name]]` to resolved anchors) sees the same links the index
/// does. It is the single place that transforms wikilink SYNTAX.
pub fn replace_wikilinks<F: FnMut(&str) -> String>(body: &str, mut f: F) -> String {
    let bytes = body.as_bytes();
    let mut out = String::with_capacity(body.len());
    let mut last = 0usize; // start of the not-yet-copied verbatim run
    let mut i = 0usize;
    let mut in_inline_code = false;
    let mut fence: Option<u8> = None;
    let mut at_line_start = true;

    while i < bytes.len() {
        let b = bytes[i];

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
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                at_line_start = true;
                continue;
            }
        }

        if fence.is_some() {
            at_line_start = b == b'\n';
            i += 1;
            continue;
        }

        if b == b'`' {
            in_inline_code = !in_inline_code;
            at_line_start = false;
            i += 1;
            continue;
        }

        if !in_inline_code && b == b'[' && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            let is_embed = i > 0 && bytes[i - 1] == b'!';
            if let Some(close) = find_double_close(bytes, i + 2) {
                if !is_embed {
                    // Flush the verbatim run up to this wikilink, then its
                    // replacement; skip the whole `[[ ... ]]` span.
                    out.push_str(&body[last..i]);
                    out.push_str(&f(&body[i + 2..close]));
                    last = close + 2;
                }
                i = close + 2;
                at_line_start = false;
                continue;
            }
        }

        at_line_start = b == b'\n';
        i += 1;
    }

    out.push_str(&body[last..]);
    out
}

/// Index of the first `]]` at or after `from`, if any.
pub fn find_double_close(bytes: &[u8], from: usize) -> Option<usize> {
    let mut i = from;
    while let Some(p) = find_byte(bytes, i, b']') {
        if p + 1 < bytes.len() && bytes[p + 1] == b']' {
            return Some(p);
        }
        i = p + 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(ps: &[&str]) -> Vec<String> {
        ps.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_name_alias_anchor() {
        let t = parse_target("name|Display#section");
        assert_eq!(t.name, "name");
        assert_eq!(t.alias.as_deref(), Some("Display"));
        assert_eq!(t.anchor.as_deref(), Some("section"));
    }

    #[test]
    fn parses_bare_name_dropping_md() {
        let t = parse_target("Live Preview.md");
        assert_eq!(t.name, "Live Preview");
        assert!(t.alias.is_none());
        assert!(t.anchor.is_none());
    }

    #[test]
    fn parses_anchor_only() {
        let t = parse_target("#heading");
        assert_eq!(t.name, "");
        assert_eq!(t.anchor.as_deref(), Some("heading"));
    }

    #[test]
    fn bare_name_resolves_by_basename() {
        let all = paths(&["concepts/codemirror.md", "index.md"]);
        assert_eq!(
            resolve_wikilink(&all, "index.md", "codemirror").as_deref(),
            Some("concepts/codemirror.md")
        );
    }

    #[test]
    fn resolution_is_case_insensitive_and_literal() {
        let all = paths(&["concepts/Live Preview.md"]);
        // Case-insensitive match; NO slug normalization.
        assert_eq!(
            resolve_wikilink(&all, "x.md", "live preview").as_deref(),
            Some("concepts/Live Preview.md")
        );
        // `live-preview` (slugged) does NOT match `Live Preview`.
        assert!(resolve_wikilink(&all, "x.md", "live-preview").is_none());
    }

    #[test]
    fn partial_path_resolves_by_suffix() {
        let all = paths(&["a/b/target.md", "z/target.md"]);
        assert_eq!(
            resolve_wikilink(&all, "x.md", "b/target").as_deref(),
            Some("a/b/target.md")
        );
    }

    #[test]
    fn duplicate_basename_tiebreaks_shortest_then_alpha() {
        // Three files share the basename `dup`; shortest path wins, then alpha.
        let all = paths(&["z/dup.md", "a/dup.md", "dup.md"]);
        assert_eq!(
            resolve_wikilink(&all, "x.md", "dup").as_deref(),
            Some("dup.md") // fewest slashes
        );
        // Among equal-depth, alphabetical: a/dup before z/dup.
        let all2 = paths(&["z/dup.md", "a/dup.md"]);
        assert_eq!(
            resolve_wikilink(&all2, "x.md", "dup").as_deref(),
            Some("a/dup.md")
        );
    }

    #[test]
    fn alias_and_anchor_are_stripped_before_matching() {
        let all = paths(&["concepts/codemirror.md"]);
        assert_eq!(
            resolve_wikilink(&all, "x.md", "codemirror|CodeMirror 6").as_deref(),
            Some("concepts/codemirror.md")
        );
        assert_eq!(
            resolve_wikilink(&all, "x.md", "codemirror#install").as_deref(),
            Some("concepts/codemirror.md")
        );
    }

    #[test]
    fn pure_anchor_resolves_to_source() {
        let all = paths(&["a.md", "b.md"]);
        assert_eq!(
            resolve_wikilink(&all, "a.md", "#heading").as_deref(),
            Some("a.md")
        );
    }

    #[test]
    fn unresolved_returns_none() {
        let all = paths(&["a.md"]);
        assert!(resolve_wikilink(&all, "a.md", "missing").is_none());
    }

    #[test]
    fn reserved_files_are_matchable_by_basename() {
        let all = paths(&["sub/index.md", "index.md"]);
        assert_eq!(
            resolve_wikilink(&all, "x.md", "index").as_deref(),
            Some("index.md")
        );
    }

    #[test]
    fn scans_wikilinks_skipping_code_and_embeds() {
        let body = "See [[Alpha]] and [[beta|B]].\n\
                    Inline `[[not a link]]` ignored.\n\
                    ```\n[[fenced]]\n```\n\
                    Embed ![[embedded.png]] skipped.\n\
                    Real [[gamma#sec]].";
        let raws = wikilink_raws(body);
        assert_eq!(raws, vec!["Alpha", "beta|B", "gamma#sec"]);
    }

    #[test]
    fn scans_tilde_fence() {
        let body = "~~~\n[[fenced]]\n~~~\n[[real]]";
        assert_eq!(wikilink_raws(body), vec!["real"]);
    }

    #[test]
    fn replace_wikilinks_agrees_with_raws_and_leaves_the_rest() {
        let body = "See [[Alpha]] and [[beta|B]].\n\
                    Inline `[[not a link]]` ignored.\n\
                    ```\n[[fenced]]\n```\n\
                    Embed ![[embedded.png]] skipped.\n\
                    Real [[gamma#sec]].";
        // The callback captures exactly the spans wikilink_raws reports.
        let mut seen = Vec::new();
        let out = replace_wikilinks(body, |raw| {
            seen.push(raw.to_string());
            format!("<{raw}>")
        });
        assert_eq!(seen, wikilink_raws(body));
        // Non-wikilink text (code, embed, fence) is preserved verbatim.
        assert!(out.contains("`[[not a link]]`"));
        assert!(out.contains("![[embedded.png]]"));
        assert!(out.contains("[[fenced]]"));
        // The real wikilinks are rewritten.
        assert!(out.contains("<Alpha>"));
        assert!(out.contains("<beta|B>"));
        assert!(out.contains("<gamma#sec>"));
    }
}
