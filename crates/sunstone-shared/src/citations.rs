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
const B_NEWLINE: u16 = b'\n' as u16;
const B_SPACE: u16 = b' ' as u16;
const B_TAB: u16 = b'\t' as u16;

fn is_ascii_digit(u: u16) -> bool {
    (b'0' as u16..=b'9' as u16).contains(&u)
}

/// Whether a lone UTF-16 unit is a whitespace char (whitespace is BMP, so the
/// unit is the whole code point).
fn is_whitespace_unit(u: u16) -> bool {
    char::from_u32(u as u32).is_some_and(|c| c.is_whitespace())
}

/// Find every inline citation reference in `text`. A `[n]` qualifies when it
/// FOLLOWS a word (the preceding unit exists and is neither whitespace nor `[`)
/// and is NOT immediately followed by `]` / `(` / `:` (a `]]` wikilink close, a
/// markdown link, or a reference-link definition). Line-start `[n]` (table rows)
/// fail the "follows a word" test and are skipped. Mirrors `findCitationRefs`.
pub fn find_citation_refs(text: &str) -> Vec<CitationRef> {
    let u: Vec<u16> = text.encode_utf16().collect();
    let n = u.len();
    let mut refs: Vec<CitationRef> = Vec::new();

    let mut i = 0;
    while i < n {
        if u[i] == B_LBRACKET {
            let mut j = i + 1;
            while j < n && is_ascii_digit(u[j]) {
                j += 1;
            }
            // A bare `[` <digits> `]` (at least one digit).
            if j > i + 1 && j < n && u[j] == B_RBRACKET {
                let from = i;
                let to = j + 1;
                let before = if i > 0 { Some(u[i - 1]) } else { None };
                let after = if to < n { Some(u[to]) } else { None };
                let follows_word =
                    matches!(before, Some(b) if !is_whitespace_unit(b) && b != B_LBRACKET);
                let trailer_ok =
                    !matches!(after, Some(a) if a == B_RBRACKET || a == B_LPAREN || a == B_COLON);
                if follows_word && trailer_ok {
                    refs.push(CitationRef {
                        from,
                        to,
                        num: String::from_utf16_lossy(&u[i + 1..j]),
                    });
                    i = to;
                    continue;
                }
            }
        }
        i += 1;
    }
    refs
}

/// UTF-16 offset of the citation-table DEFINITION for `num` — the first line
/// whose first non-blank content is `[num]` (allowing leading spaces/tabs). The
/// offset of the `[`, or `None`. Mirrors `citationDefPos`.
pub fn citation_def_pos(text: &str, num: &str) -> Option<usize> {
    let u: Vec<u16> = text.encode_utf16().collect();
    let n = u.len();
    let target: Vec<u16> = format!("[{num}]").encode_utf16().collect();

    // Every line start: offset 0, and every index just after a `\n`.
    let mut starts = vec![0usize];
    for (idx, &c) in u.iter().enumerate() {
        if c == B_NEWLINE {
            starts.push(idx + 1);
        }
    }
    for &s in &starts {
        let mut i = s;
        while i < n && (u[i] == B_SPACE || u[i] == B_TAB) {
            i += 1;
        }
        if i + target.len() <= n && u[i..i + target.len()] == *target {
            return Some(i);
        }
    }
    None
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
}
