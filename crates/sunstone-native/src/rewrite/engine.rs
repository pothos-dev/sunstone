//! Pure link-rewrite engine: given a move map and source content, compute the
//! rewritten content for every affected link. No filesystem or index access —
//! exhaustively unit-testable (see the tests at the bottom of this file). The
//! orchestration in `rewrite.rs` reads/writes files and drives this engine.
//!
//! Path math mirrors `src/lib/links.ts` / `index.rs` EXACTLY (bundle-relative,
//! '/'-separated; `.`/`..` collapse with leading-`..` escapes dropped).

use std::collections::HashMap;

use serde::Serialize;

use crate::paths::{dir_of, find_byte, is_external, resolve_internal};
use crate::wikilink::{self, find_double_close, parse_target};

use super::paths::{basename_of, relative_path, shortest_resolving_suffix, split_suffix, utf8_len};

/// Summary of an auto-rewrite pass: how many links across how many files were
/// changed. Matches the TS `{ linksChanged, filesChanged }`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteSummary {
    pub links_changed: usize,
    pub files_changed: usize,
}

/// Compute the rewritten content for every Concept affected by a set of moves.
///
/// `moves` maps each moved Concept's OLD bundle-relative path to its NEW one
/// (one entry for a single Concept; every descendant `.md` for a folder move).
/// `read` loads a Concept's current content by its CURRENT (pre-move) path.
///
/// Returns, for each Concept that actually changed, the NEW path to write to and
/// the rewritten content, plus the aggregate summary. A moved Concept is keyed
/// by its NEW path (its content is written at the new location); an inbound
/// source that did not move is keyed by its unchanged path.
///
/// This is pure: it performs no IO itself (the caller does the fs move + writes),
/// so it is exhaustively unit-testable.
pub fn plan_rewrites<F>(
    moves: &HashMap<String, String>,
    affected_sources: &[String],
    all_paths: &[String],
    mut read: F,
) -> Result<(Vec<(String, String)>, RewriteSummary), String>
where
    F: FnMut(&str) -> Result<String, String>,
{
    // The NEW bundle path set (old paths with moves applied), used to recompute
    // the shortest wikilink suffix that resolves to a moved target.
    let new_paths: Vec<String> = all_paths
        .iter()
        .map(|p| moves.get(p).cloned().unwrap_or_else(|| p.clone()))
        .collect();
    let mut writes: Vec<(String, String)> = Vec::new();
    let mut summary = RewriteSummary::default();

    // Process a stable, de-duplicated set of source paths. A source is either a
    // moved Concept (rewrite its own relative outbound links) or an external
    // inbound linker (rewrite links that point at a moved Concept). The two sets
    // overlap when a moved Concept also links to another moved Concept.
    let mut seen = std::collections::BTreeSet::new();
    let mut sources: Vec<&str> = Vec::new();
    for s in affected_sources.iter().chain(moves.keys()) {
        if seen.insert(s.as_str()) {
            sources.push(s.as_str());
        }
    }
    sources.sort_unstable();

    for old_source in sources {
        // The source content lives at its current (old) path on disk.
        let content = read(old_source)?;
        // For resolution + relative recomputation, a moved source uses its NEW
        // directory as the base; an unmoved source uses its own path.
        let new_source = moves
            .get(old_source)
            .map(String::as_str)
            .unwrap_or(old_source);

        let (rewritten, count) = rewrite_links_in(
            old_source,
            new_source,
            &content,
            moves,
            all_paths,
            &new_paths,
        );
        // When count == 0 we emit no write: an unmoved source is untouched, and
        // a moved source with no link changes is relocated by the caller's fs
        // move (its content is already correct at the new path).
        if count > 0 {
            summary.links_changed += count;
            summary.files_changed += 1;
            writes.push((new_source.to_string(), rewritten));
        }
    }

    Ok((writes, summary))
}

/// Rewrite every link in `content` whose resolved target is a moved Concept.
///
/// `old_source` is the path the link resolution base would use BEFORE the move
/// (used to resolve relative links as the author wrote them). `new_source` is the
/// path the file will live at AFTER the move (used both to RE-RESOLVE relative
/// links — since the file's directory changed — and to compute new relative
/// targets from). For an unmoved inbound source the two are equal.
///
/// Returns the rewritten content and the number of links changed.
fn rewrite_links_in(
    old_source: &str,
    new_source: &str,
    content: &str,
    moves: &HashMap<String, String>,
    all_paths: &[String],
    new_paths: &[String],
) -> (String, usize) {
    let moved = old_source != new_source;
    let mut out = String::with_capacity(content.len());
    let mut count = 0usize;
    let bytes = content.as_bytes();
    let mut i = 0usize;
    // Code state so wikilinks inside code are left untouched (mirrors the
    // extraction scanner in `wikilink::wikilink_raws`). Markdown links keep
    // their original code-agnostic behaviour.
    let mut in_inline_code = false;
    let mut fence: Option<u8> = None;
    let mut at_line_start = true;

    while i < bytes.len() {
        // --- Fenced code blocks (line-start ``` / ~~~) -------------------
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
                // Copy the whole fence line through verbatim.
                let line_end = find_byte(bytes, i, b'\n').map(|p| p + 1).unwrap_or(bytes.len());
                out.push_str(&content[i..line_end]);
                i = line_end;
                at_line_start = true;
                continue;
            }
        }

        // --- Wikilink `[[ ... ]]` (name-based) ---------------------------
        if fence.is_none()
            && !in_inline_code
            && bytes[i] == b'['
            && i + 1 < bytes.len()
            && bytes[i + 1] == b'['
        {
            // Embeds (`![[ ... ]]`) are OUT OF SCOPE for v1 — leave untouched,
            // like the markdown image branch below. Embed support is DEFERRED.
            let is_embed = i > 0 && bytes[i - 1] == b'!';
            if let Some(close) = find_double_close(bytes, i + 2) {
                let raw = &content[i + 2..close];
                let replacement = if is_embed {
                    None
                } else {
                    rewrite_wikilink(old_source, raw, moves, all_paths, new_paths)
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

        if fence.is_none() && bytes[i] == b'[' {
            let is_image = i > 0 && bytes[i - 1] == b'!';
            if let Some(close) = find_byte(bytes, i + 1, b']') {
                if close + 1 < bytes.len() && bytes[close + 1] == b'(' {
                    if let Some(paren) = find_byte(bytes, close + 2, b')') {
                        // The whole `(...)` inner text (target + optional title).
                        let inner = &content[close + 2..paren];
                        let new_inner = if is_image {
                            None
                        } else {
                            rewrite_target(old_source, new_source, moved, inner, moves)
                        };
                        // Emit `[...]( ` then the (possibly rewritten) inner.
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
        // Default: copy this byte through.
        at_line_start = bytes[i] == b'\n';
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&content[i..i + ch_len]);
        i += ch_len;
    }

    (out, count)
}

/// Given the inside of a link's parens (`target "title"`), decide whether the
/// target resolves to a moved Concept and, if so, return the rewritten inner
/// text (new target, original anchor/query/title preserved). `None` means leave
/// the link unchanged.
fn rewrite_target(
    old_source: &str,
    new_source: &str,
    moved: bool,
    inner: &str,
    moves: &HashMap<String, String>,
) -> Option<String> {
    // Split off leading whitespace and an optional `<...>` / trailing title so we
    // only touch the URL itself. Mirrors `extract_href`.
    let leading_ws_len = inner.len() - inner.trim_start().len();
    let leading = &inner[..leading_ws_len];
    let rest = &inner[leading_ws_len..];

    // The URL is up to the first whitespace; everything after is the title.
    let (url_raw, title) = match rest.find(char::is_whitespace) {
        Some(p) => (&rest[..p], &rest[p..]),
        None => (rest, ""),
    };
    if url_raw.is_empty() {
        return None;
    }

    // Strip optional angle brackets around the URL (preserve to re-apply).
    let (angle_open, url_core, angle_close) = if url_raw.starts_with('<') && url_raw.ends_with('>') {
        ("<", &url_raw[1..url_raw.len() - 1], ">")
    } else {
        ("", url_raw, "")
    };

    if is_external(url_core) || url_core.starts_with('#') {
        return None;
    }

    // Separate path | anchor | query, preserving order/content of the suffix.
    let (path_part, suffix) = split_suffix(url_core);
    if path_part.is_empty() {
        return None;
    }

    let is_absolute = path_part.starts_with('/');

    // Resolve as the author wrote it, from the source's ORIGINAL location.
    let resolved = resolve_internal(old_source, path_part)?;
    // The target's NEW location: if the target itself moved, its mapped path;
    // otherwise it stays where it is.
    let target_moved = moves.contains_key(&resolved);
    let new_target = moves.get(&resolved).cloned().unwrap_or(resolved);

    // Decide whether this link needs rewriting at all:
    //   * ABSOLUTE links only change when their TARGET moved (a moved source's
    //     own absolute links are unaffected).
    //   * RELATIVE links change when the target moved OR the source moved (its
    //     base directory changed, so the relative string must be recomputed).
    if is_absolute {
        if !target_moved {
            return None;
        }
    } else if !target_moved && !moved {
        return None;
    }

    let new_path = if is_absolute {
        // Absolute links always point from the root: use the new absolute path.
        format!("/{new_target}")
    } else {
        // Relative: recompute from the SOURCE's new directory to the target's new
        // location, preserving the relative style.
        relative_path(dir_of(new_source), &new_target)
    };

    if new_path == path_part {
        // No textual change (e.g. recomputed to the identical relative string).
        return None;
    }

    Some(format!(
        "{leading}{angle_open}{new_path}{suffix}{angle_close}{title}"
    ))
}

/// Decide whether a wikilink (raw inner text of `[[ ... ]]`) needs rewriting
/// because its resolved target moved, and if so return the new inner text.
/// `None` leaves the wikilink unchanged. See spec §4.
///
/// Resolution uses the OLD bundle state, from the source's OLD location. The
/// `|alias` and `#anchor` are preserved VERBATIM (they never participate in
/// resolution). A BARE name only changes when the target's BASENAME changed —
/// a pure folder move leaves bare wikilinks untouched (they resolve by basename
/// bundle-wide). A PARTIAL PATH is recomputed to the shortest suffix that still
/// resolves to the moved file in the NEW bundle state.
fn rewrite_wikilink(
    old_source: &str,
    raw: &str,
    moves: &HashMap<String, String>,
    all_paths: &[String],
    new_paths: &[String],
) -> Option<String> {
    let target = parse_target(raw);
    // A pure same-file anchor (`[[#heading]]`) has no name to rewrite.
    if target.name.trim().is_empty() {
        return None;
    }
    // Resolve from the OLD bundle state at the source's OLD location.
    let resolved = wikilink::resolve_wikilink(all_paths, old_source, raw)?;
    // Only rewrite if the resolved target actually moved.
    let new_target = moves.get(&resolved)?;

    let is_partial = target.name.contains('/');
    let new_name = if is_partial {
        // Shortest suffix of the NEW path that resolves (per §1, against the new
        // path set) back to `new_target`. Try basename, then progressively add
        // leading segments; fall back to the full new path.
        shortest_resolving_suffix(new_paths, old_source, new_target)
    } else {
        // Bare name: rewrite to the new BASENAME. If the basename did not change
        // (folder-only move), this yields no textual change and we leave it.
        basename_of(new_target).to_string()
    };

    // Rebuild the inner text from the boundaries of the original `raw`, so the
    // alias/anchor (and their ORIGINAL delimiters/whitespace) survive verbatim.
    let rebuilt = rebuild_inner(raw, &new_name);
    if rebuilt == raw {
        return None;
    }
    Some(rebuilt)
}

/// Rebuild a wikilink inner text, replacing only the NAME portion and keeping
/// the rest (alias `|...` and/or anchor `#...`) byte-for-byte. The name ends at
/// whichever of the first `|` or first `#` comes first; everything from there on
/// is appended verbatim.
fn rebuild_inner(raw: &str, new_name: &str) -> String {
    format!("{}{}", new_name, &raw[wikilink::name_end(raw)..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn moves(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    /// Run plan_rewrites over an in-memory file map, returning the resulting map
    /// (new path -> content) merged onto the originals, plus the summary.
    fn run(
        files: &[(&str, &str)],
        moves_map: &HashMap<String, String>,
    ) -> (HashMap<String, String>, RewriteSummary) {
        let store: HashMap<String, String> = files
            .iter()
            .map(|(p, c)| (p.to_string(), c.to_string()))
            .collect();

        // Inbound sources = every file linking to a moved target. For the unit
        // tests we just pass ALL files as candidate sources; plan_rewrites only
        // emits writes for files that actually change.
        let sources: Vec<String> = store.keys().cloned().collect();
        let all_paths: Vec<String> = store.keys().cloned().collect();

        let store_ref = &store;
        let (writes, summary) = plan_rewrites(moves_map, &sources, &all_paths, |p| {
            store_ref
                .get(p)
                .cloned()
                .ok_or_else(|| format!("no such file: {p}"))
        })
        .unwrap();

        let mut result = store.clone();
        // Apply the move (rename keys) first.
        for (old, new) in moves_map {
            if let Some(c) = result.remove(old) {
                result.insert(new.clone(), c);
            }
        }
        // Then overlay rewritten content.
        for (path, content) in writes {
            result.insert(path, content);
        }
        (result, summary)
    }

    #[test]
    fn inbound_absolute_link_is_rewritten_to_new_absolute_path() {
        // A links to B with an ABSOLUTE link. B moves; A's link follows.
        let files = &[
            ("a.md", "See [B](/b.md) here."),
            ("b.md", "# B"),
        ];
        let m = moves(&[("b.md", "folder/b.md")]);
        let (result, summary) = run(files, &m);
        assert_eq!(result["a.md"], "See [B](/folder/b.md) here.");
        assert_eq!(summary.links_changed, 1);
        assert_eq!(summary.files_changed, 1);
    }

    #[test]
    fn inbound_relative_link_from_different_dir_is_recomputed() {
        // C (in sub/) links to B with a RELATIVE link. B moves to folder/.
        // The recomputed relative path must point from sub/ to folder/b.md.
        let files = &[
            ("sub/c.md", "Link to [B](../b.md)."),
            ("b.md", "# B"),
        ];
        let m = moves(&[("b.md", "folder/b.md")]);
        let (result, summary) = run(files, &m);
        // From sub/ to folder/b.md: ../folder/b.md
        assert_eq!(result["sub/c.md"], "Link to [B](../folder/b.md).");
        assert_eq!(summary.links_changed, 1);
        // Verify it still resolves correctly.
        assert_eq!(
            resolve_internal("sub/c.md", "../folder/b.md").as_deref(),
            Some("folder/b.md")
        );
    }

    #[test]
    fn moved_files_own_relative_outbound_is_rewritten() {
        // B has a relative link to D. B moves into folder/; the relative link to
        // D must be recomputed so it still resolves to d.md at the root.
        let files = &[
            ("b.md", "Out to [D](./d.md)."),
            ("d.md", "# D"),
        ];
        // Only B moves; D stays put. A moved file's relative outbound links must
        // still be recomputed (its base directory changed) even though the target
        // did not move — no identity move-map entry needed.
        let m = moves(&[("b.md", "folder/b.md")]);
        let (result, summary) = run(files, &m);
        // From folder/ to d.md (root): ../d.md
        assert_eq!(result["folder/b.md"], "Out to [D](../d.md).");
        assert_eq!(summary.links_changed, 1);
        assert_eq!(
            resolve_internal("folder/b.md", "../d.md").as_deref(),
            Some("d.md")
        );
    }

    #[test]
    fn moved_files_own_absolute_outbound_is_untouched() {
        let files = &[("b.md", "Out to [D](/d.md)."), ("d.md", "# D")];
        let m = moves(&[("b.md", "folder/b.md")]);
        let (result, summary) = run(files, &m);
        // Absolute link unaffected by the source move.
        assert_eq!(result["folder/b.md"], "Out to [D](/d.md).");
        assert_eq!(summary.links_changed, 0);
    }

    #[test]
    fn folder_move_keeps_internal_links_valid_without_double_break() {
        // folder/ contains x.md and y.md; x links to y relatively. Move folder/
        // to dest/. The internal x->y link must remain valid (recomputed once).
        let files = &[
            ("folder/x.md", "[Y](./y.md)"),
            ("folder/y.md", "# Y"),
        ];
        let m = moves(&[
            ("folder/x.md", "dest/x.md"),
            ("folder/y.md", "dest/y.md"),
        ]);
        let (result, summary) = run(files, &m);
        // x and y both moved to dest/; ./y.md is still correct -> NO change.
        assert_eq!(result["dest/x.md"], "[Y](./y.md)");
        // No links changed: the relative link between two co-moved siblings is
        // identical before and after.
        assert_eq!(summary.links_changed, 0);
        assert_eq!(
            resolve_internal("dest/x.md", "./y.md").as_deref(),
            Some("dest/y.md")
        );
    }

    #[test]
    fn folder_move_recomputes_inbound_from_outside() {
        // outside.md links to folder/x.md absolutely; folder moves to dest/.
        let files = &[
            ("outside.md", "[X](/folder/x.md)"),
            ("folder/x.md", "# X"),
        ];
        let m = moves(&[("folder/x.md", "dest/x.md")]);
        let (result, summary) = run(files, &m);
        assert_eq!(result["outside.md"], "[X](/dest/x.md)");
        assert_eq!(summary.links_changed, 1);
    }

    #[test]
    fn preserves_anchor_query_and_title_and_text() {
        let files = &[
            ("a.md", "[B link](/b.md#section?x=1 \"My Title\")"),
            ("b.md", "# B"),
        ];
        let m = moves(&[("b.md", "folder/b.md")]);
        let (result, summary) = run(files, &m);
        assert_eq!(
            result["a.md"],
            "[B link](/folder/b.md#section?x=1 \"My Title\")"
        );
        assert_eq!(summary.links_changed, 1);
    }

    #[test]
    fn never_touches_external_or_unrelated_links() {
        let files = &[
            (
                "a.md",
                "[ext](https://example.com) and [other](/keep.md) and [B](/b.md)",
            ),
            ("b.md", "# B"),
            ("keep.md", "# Keep"),
        ];
        let m = moves(&[("b.md", "folder/b.md")]);
        let (result, summary) = run(files, &m);
        assert_eq!(
            result["a.md"],
            "[ext](https://example.com) and [other](/keep.md) and [B](/folder/b.md)"
        );
        assert_eq!(summary.links_changed, 1);
    }

    #[test]
    fn images_are_not_rewritten() {
        let files = &[("a.md", "![img](/b.md)"), ("b.md", "# B")];
        let m = moves(&[("b.md", "folder/b.md")]);
        let (result, summary) = run(files, &m);
        assert_eq!(result["folder/b.md"], "# B"); // moved
        assert_eq!(result["a.md"], "![img](/b.md)"); // image left alone
        assert_eq!(summary.links_changed, 0);
    }

    // --- Wikilink rename-rewrite (spec §4) -----------------------------------

    #[test]
    fn bare_wikilink_rewritten_on_basename_rename() {
        // a links to old.md by bare wikilink. old.md is renamed to new.md.
        let files = &[("a.md", "see [[old]] here"), ("old.md", "# Old")];
        let m = moves(&[("old.md", "new.md")]);
        let (result, summary) = run(files, &m);
        assert_eq!(result["a.md"], "see [[new]] here");
        assert_eq!(summary.links_changed, 1);
    }

    #[test]
    fn bare_wikilink_untouched_on_folder_only_move() {
        // old.md moves into a folder but keeps its basename. A bare wikilink
        // resolves by basename bundle-wide, so it must NOT be rewritten.
        let files = &[("a.md", "see [[old]] here"), ("old.md", "# Old")];
        let m = moves(&[("old.md", "folder/old.md")]);
        let (result, summary) = run(files, &m);
        assert_eq!(result["a.md"], "see [[old]] here");
        assert_eq!(summary.links_changed, 0);
    }

    #[test]
    fn bare_wikilink_preserves_alias_and_anchor() {
        let files = &[
            ("a.md", "[[old|Display]] and [[old#sec]]"),
            ("old.md", "# Old"),
        ];
        let m = moves(&[("old.md", "new.md")]);
        let (result, summary) = run(files, &m);
        assert_eq!(result["a.md"], "[[new|Display]] and [[new#sec]]");
        assert_eq!(summary.links_changed, 2);
    }

    #[test]
    fn partial_path_wikilink_recomputed_to_resolving_suffix() {
        // a links to sub/old.md by partial path. The whole folder sub/ moves to
        // dest/. The partial-path wikilink must be recomputed so it still
        // resolves to the moved file. Since the basename `old` is unique in the
        // new bundle, the shortest resolving suffix is the bare basename.
        let files = &[
            ("a.md", "see [[sub/old]] here"),
            ("sub/old.md", "# Old"),
        ];
        let m = moves(&[("sub/old.md", "dest/old.md")]);
        let (result, summary) = run(files, &m);
        assert_eq!(result["a.md"], "see [[old]] here");
        assert_eq!(summary.links_changed, 1);
    }

    #[test]
    fn partial_path_wikilink_keeps_folder_when_basename_is_ambiguous() {
        // Two files share basename `dup`. a links to sub/dup specifically; sub/
        // moves to zzz/. The bare basename `dup` would resolve to the OTHER dup
        // (`aaa/dup.md` sorts first), so the suffix must keep enough path
        // (`zzz/dup`) to keep pointing at the moved file.
        let files = &[
            ("a.md", "[[sub/dup]]"),
            ("sub/dup.md", "# Sub dup"),
            ("aaa/dup.md", "# Other dup"),
        ];
        let m = moves(&[("sub/dup.md", "zzz/dup.md")]);
        let (result, summary) = run(files, &m);
        assert_eq!(result["a.md"], "[[zzz/dup]]");
        assert_eq!(summary.links_changed, 1);
    }

    #[test]
    fn unresolved_wikilink_is_not_rewritten() {
        let files = &[("a.md", "[[missing]]"), ("old.md", "# Old")];
        let m = moves(&[("old.md", "new.md")]);
        let (result, summary) = run(files, &m);
        assert_eq!(result["a.md"], "[[missing]]");
        assert_eq!(summary.links_changed, 0);
    }

    #[test]
    fn wikilink_in_code_is_not_rewritten() {
        let files = &[
            ("a.md", "real [[old]]\n```\ncode [[old]]\n```\ninline `[[old]]`"),
            ("old.md", "# Old"),
        ];
        let m = moves(&[("old.md", "new.md")]);
        let (result, summary) = run(files, &m);
        assert_eq!(
            result["a.md"],
            "real [[new]]\n```\ncode [[old]]\n```\ninline `[[old]]`"
        );
        assert_eq!(summary.links_changed, 1);
    }

    #[test]
    fn wikilink_embed_is_not_rewritten() {
        let files = &[("a.md", "![[old]] and [[old]]"), ("old.md", "# Old")];
        let m = moves(&[("old.md", "new.md")]);
        let (result, summary) = run(files, &m);
        // Embed left alone; the plain wikilink rewritten.
        assert_eq!(result["a.md"], "![[old]] and [[new]]");
        assert_eq!(summary.links_changed, 1);
    }
}
