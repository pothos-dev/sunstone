//! Citation-reference detection (ADR 0006 family 13).
//!
//! The ONE source of truth for citation parsing, folding the former TS
//! `citations.ts::{findCitationRefs, citationDefPos}` and the native
//! `render.rs` citation scanner (which now builds its comrak sentinels from
//! [`find_citation_refs`]). The CodeMirror superscript-widget HALF stays TS,
//! thin over these offset spans (ADR 0006 §4 seam).
//!
//! A "citation reference" is a bracketed number that FOLLOWS a word inline —
//! e.g. the `[6][7][8]` at the end of a sentence — rendered as a superscript
//! link. A "citation definition" is the same `[n]` at the START of a line — the
//! citation-table rows, the jump targets, left literal.
//!
//! **Offsets are UTF-16 code units** (the editor addresses its doc in JS string
//! / CodeMirror positions), so the scan runs over `str::encode_utf16`, mirroring
//! the TS regex `m.index` / `text[i]` semantics.

use serde::{Deserialize, Serialize};

use crate::paths::find_byte;
use crate::scan::{walk_code, CodeClass};

/// A citation reference found in text: its `[n]` span (UTF-16 offsets) and the
/// number `n` as written (digits only).
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationRef {
    /// Offset of the `[` (inclusive), UTF-16 units into the scanned text.
    pub from: usize,
    /// Offset just past the `]` (exclusive).
    pub to: usize,
    /// The citation number as written (digits only, e.g. `"7"`).
    pub num: String,
}

const B_LBRACKET: u16 = b'[' as u16;
const B_RBRACKET: u16 = b']' as u16;
const B_LPAREN: u16 = b'(' as u16;
const B_COLON: u16 = b':' as u16;

fn is_ascii_digit(u: u16) -> bool {
    (b'0' as u16..=b'9' as u16).contains(&u)
}

/// Whether a lone UTF-16 unit is a whitespace char (whitespace is BMP, so the
/// unit is the whole code point).
fn is_whitespace_unit(u: u16) -> bool {
    char::from_u32(u as u32).is_some_and(|c| c.is_whitespace())
}

/// Find every inline citation reference in `text`. A `[n]` qualifies when it
/// FOLLOWS a word and is NOT immediately followed by `]` / `(` / `:` (a `]]`
/// wikilink close, a markdown link, or a reference-link definition — the
/// [`trailer_ok`] guard). "Follows a word" means the preceding unit exists and
/// is neither whitespace nor `[`; a preceding `]` counts only when it closes a
/// citation reference (the `[6][7]` chain) or a `]]` wikilink, since after any
/// other bracketed label (`[text][1]`) the `[n]` is a reference-link label.
/// Line-start `[n]` (table rows) fail the "follows a word" test and are
/// skipped. Mirrors `findCitationRefs`.
pub fn find_citation_refs(text: &str) -> Vec<CitationRef> {
    let u: Vec<u16> = text.encode_utf16().collect();
    let n = u.len();
    let mut refs: Vec<CitationRef> = Vec::new();

    let mut i = 0;
    while i < n {
        if let Some(to) = bracketed_number_end(&u, i) {
            let follows_word = match i.checked_sub(1).map(|p| u[p]) {
                None => false,
                Some(B_RBRACKET) => {
                    refs.last().is_some_and(|r| r.to == i) || (i >= 2 && u[i - 2] == B_RBRACKET)
                }
                Some(b) => !is_whitespace_unit(b) && b != B_LBRACKET,
            };
            if follows_word && trailer_ok(&u, to) {
                refs.push(CitationRef {
                    from: i,
                    to,
                    num: String::from_utf16_lossy(&u[i + 1..to - 1]),
                });
                i = to;
                continue;
            }
        }
        i += 1;
    }
    refs
}

/// When a bare `[` <digits> `]` (at least one digit) starts at `i`, the offset
/// just past its `]`.
fn bracketed_number_end(u: &[u16], i: usize) -> Option<usize> {
    if u.get(i) != Some(&B_LBRACKET) {
        return None;
    }
    let digits = u[i + 1..].iter().take_while(|&&c| is_ascii_digit(c)).count();
    let close = i + 1 + digits;
    (digits > 0 && u.get(close) == Some(&B_RBRACKET)).then_some(close + 1)
}

/// Whether the unit at `to` (just past a `[n]`) leaves it a citation: not a
/// `]` (wikilink close), `(` (markdown link) or `:` (reference definition).
fn trailer_ok(u: &[u16], to: usize) -> bool {
    !matches!(u.get(to), Some(&(B_RBRACKET | B_LPAREN | B_COLON)))
}

/// A citation DEFINITION (citation-table row): the line-start `[n]` span
/// (UTF-16 offsets) and its number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CitationDef {
    /// Offset of the `[` (inclusive), UTF-16 units into the scanned text.
    pub from: usize,
    /// Offset just past the `]` (exclusive).
    pub to: usize,
    /// The citation number as written (digits only).
    pub num: String,
}

/// Every citation-table DEFINITION in `text`, in order: a `[n]` that is the
/// first content of its line (after optional spaces/tabs only), passes the
/// same [`trailer_ok`] guard as a reference (so `[1](url)` and `[1]: url` stay
/// markdown), and lies outside fenced code blocks and inline code spans (the
/// shared [`crate::scan`] code contract). The editor's jump target
/// ([`citation_def_pos`]) and the native render's row anchors both use this.
pub fn find_citation_defs(text: &str) -> Vec<CitationDef> {
    let bytes = text.as_bytes();
    let mut in_code = vec![false; bytes.len()];
    walk_code(bytes, |i, class| {
        match class {
            CodeClass::FenceLine { end } => in_code[i..end].fill(true),
            CodeClass::Fenced | CodeClass::Tick => in_code[i] = true,
            CodeClass::Text { in_inline_code } => in_code[i] = in_inline_code,
        }
        None
    });

    let u: Vec<u16> = text.encode_utf16().collect();
    let mut defs = Vec::new();
    // Walk line starts in bytes, carrying the matching UTF-16 offset along.
    let (mut byte, mut unit) = (0usize, 0usize);
    let mut line_start = Some(0usize);
    while let Some(s) = line_start {
        unit += text[byte..s].encode_utf16().count();
        byte = s;
        let indent = bytes[s..].iter().take_while(|&&b| b == b' ' || b == b'\t').count();
        let (b, from) = (s + indent, unit + indent);
        if b < bytes.len() && !in_code[b] {
            if let Some(to) = bracketed_number_end(&u, from).filter(|&to| trailer_ok(&u, to)) {
                defs.push(CitationDef {
                    from,
                    to,
                    num: String::from_utf16_lossy(&u[from + 1..to - 1]),
                });
            }
        }
        line_start = find_byte(bytes, s, b'\n').map(|p| p + 1);
    }
    defs
}

/// UTF-16 offset of the citation-table DEFINITION for `num` — the first
/// [`find_citation_defs`] row numbered `num`. The offset of the `[`, or `None`.
/// Mirrors `citationDefPos`.
pub fn citation_def_pos(text: &str, num: &str) -> Option<usize> {
    find_citation_defs(text).into_iter().find(|d| d.num == num).map(|d| d.from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nums(text: &str) -> Vec<String> {
        find_citation_refs(text).into_iter().map(|r| r.num).collect()
    }

    #[test]
    fn inline_refs_following_a_word() {
        let refs = find_citation_refs("deep umami and body.[6][7][8]");
        assert_eq!(
            refs.iter().map(|r| r.num.as_str()).collect::<Vec<_>>(),
            vec!["6", "7", "8"]
        );
        assert_eq!(refs[0].from, 20);
        assert_eq!(refs[0].to, 23);
    }

    #[test]
    fn line_start_definition_is_not_a_reference() {
        // A `[6]` at line start (a table row) is skipped as a reference.
        assert!(nums("[6] The basic taste.").is_empty());
        assert!(nums("  [6] indented row").is_empty());
    }

    #[test]
    fn space_preceded_bracket_is_left_alone() {
        assert!(nums("a paragraph [6] mid-sentence").is_empty());
    }

    #[test]
    fn disambiguating_trailers_are_rejected() {
        assert!(nums("word[6](url)").is_empty()); // markdown link
        assert!(nums("word[6]: def").is_empty()); // reference definition
        assert!(nums("[[6]]").is_empty()); // wikilink fragment (preceded by `[`)
    }

    #[test]
    fn adjacent_ref_after_a_closing_bracket_counts() {
        // In `[6][7]`, `[7]` follows the `]` of `[6]` — a non-space non-`[` char.
        let refs = find_citation_refs("x[6][7]");
        assert_eq!(refs.iter().map(|r| r.num.as_str()).collect::<Vec<_>>(), vec!["6", "7"]);
    }

    #[test]
    fn offsets_are_utf16_units() {
        let refs = find_citation_refs("😀x[6]");
        // 😀 = 2 units, x = 1 → `[` at offset 3.
        assert_eq!(refs[0].from, 3);
    }

    #[test]
    fn def_pos_finds_first_row() {
        let text = "body.[6]\n\n[6] Kokumi source.\n";
        let pos = citation_def_pos(text, "6").unwrap();
        // The `[6]` at line start (after the blank line): "body.[6]\n\n" = 10 units.
        assert_eq!(pos, 10);
    }

    #[test]
    fn def_pos_allows_leading_indentation() {
        let text = "x[3]\n   [3] def\n";
        let pos = citation_def_pos(text, "3").unwrap();
        // Line 2 starts at 5; three spaces then `[` at 8.
        assert_eq!(pos, 8);
    }

    #[test]
    fn def_pos_none_when_missing() {
        assert_eq!(citation_def_pos("body.[6]\n", "6"), None);
    }

    fn def_nums(text: &str) -> Vec<String> {
        find_citation_defs(text).into_iter().map(|d| d.num).collect()
    }

    #[test]
    fn defs_are_line_start_rows() {
        let defs = find_citation_defs("body.[6]\n\n[6] Kokumi.\n  [7] Indented.\n\t[8] Tabbed.\n");
        assert_eq!(
            defs.iter().map(|d| d.num.as_str()).collect::<Vec<_>>(),
            vec!["6", "7", "8"]
        );
        assert_eq!((defs[0].from, defs[0].to), (10, 13));
    }

    #[test]
    fn defs_reject_the_reference_trailers() {
        assert!(def_nums("[1](https://x)").is_empty()); // markdown link
        assert!(def_nums("[1]: https://x").is_empty()); // reference definition
        assert!(def_nums("[1]] stray").is_empty());
        // A def at the very end of the text has no trailer: still a def.
        assert_eq!(def_nums("[1]"), vec!["1"]);
    }

    #[test]
    fn defs_indent_only_by_space_or_tab() {
        assert!(def_nums("\u{a0}[1] nbsp").is_empty());
        assert!(def_nums("\u{3000}[1] ideographic space").is_empty());
        assert!(def_nums("text [1] mid-line").is_empty());
    }

    #[test]
    fn defs_skip_code() {
        assert!(def_nums("```\n[1] fenced\n```\n").is_empty());
        assert!(def_nums("~~~\n  [1] fenced\n~~~\n").is_empty());
        // A line-start `[1]` inside an inline code span that wraps a line.
        assert!(def_nums("`a\n[1] b`\n").is_empty());
        // After the fence closes, rows count again.
        assert_eq!(def_nums("```\n[1] x\n```\n[2] row\n"), vec!["2"]);
    }

    #[test]
    fn defs_offsets_are_utf16_units() {
        let defs = find_citation_defs("😀\n[4] row");
        // 😀 = 2 units + `\n` → `[` at 3.
        assert_eq!((defs[0].from, defs[0].to), (3, 6));
    }

    #[test]
    fn def_pos_skips_non_definitions() {
        let text = "[6](https://x)\n```\n[6] code\n```\n[6] the row\n";
        let pos = citation_def_pos(text, "6").unwrap();
        assert_eq!(&text[pos..pos + 7], "[6] the");
    }

    #[test]
    fn bracketed_label_before_a_number_is_a_reference_link_not_a_citation() {
        // `[text][1]` is a markdown reference link; only a `]` that closes a
        // citation (or a `]]` wikilink) chains into the next reference.
        assert!(nums("See [the source][1].").is_empty());
        assert_eq!(nums("x[6][7][8]"), vec!["6", "7", "8"]);
        assert_eq!(nums("see [[Note]][3]"), vec!["3"]);
    }
}
