//! CriticMarkup parsing + highlight/comment grouping (ADR 0006 family 13).
//!
//! The ONE source of truth for the CriticMarkup PARSE half, folding the former
//! TS `editor/criticMarkup.ts::{parseCriticMarks, pairAnnotations, annotationAt}`
//! and the native `render.rs` critic scanner (which now builds its comrak
//! sentinels from [`parse_critic_marks`]). The CodeMirror decoration/authoring
//! HALF stays TS (thin over these offset-span structs — ADR 0006 §4 seam).
//!
//! The five marks (delimiters carry no required inner spaces; inner whitespace
//! is verbatim content):
//!   addition `{++ text ++}`, deletion `{-- text --}`,
//!   substitution `{~~ old ~> new ~~}`, comment `{>> text <<}`,
//!   highlight `{== text ==}`.
//!
//! **Offsets are UTF-16 code units** — the editor addresses its document in JS
//! string / CodeMirror positions (UTF-16), so the returned `from`/`to`/
//! `contentFrom`/`contentTo` spans MUST count UTF-16 units, not Rust bytes, to
//! land the decorations correctly on non-ASCII content. The scan therefore runs
//! over the doc's UTF-16 units (`str::encode_utf16`), exactly mirroring the TS
//! `doc.slice` / `doc.indexOf` semantics.

use serde::{Deserialize, Serialize};

/// One of the five CriticMarkup mark kinds (serialised as the lowercase string
/// the TS `CriticMarkKind` union uses).
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CriticMarkKind {
    Addition,
    Deletion,
    Substitution,
    Comment,
    Highlight,
}

/// A single CriticMarkup mark: its full span (delimiters included), its inner
/// content span, and the payload text (all offsets in UTF-16 code units, ADR
/// 0006 §4 spans-out seam). `text` carries the inner text for addition /
/// deletion / comment / highlight; `deleted` / `inserted` carry a
/// substitution's two halves. tsify-canonical (into + from wasm — `pairAnnotations`
/// / `annotationAt` take marks back across the boundary).
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CriticMark {
    pub kind: CriticMarkKind,
    /// Full span INCLUDING delimiters: `[from, to)` UTF-16 offsets into the doc.
    pub from: usize,
    pub to: usize,
    /// Inner content span (between the delimiters): `[content_from, content_to)`.
    pub content_from: usize,
    pub content_to: usize,
    /// Inner text for addition / deletion / comment / highlight (raw, untrimmed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Substitution only: text before `~>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<String>,
    /// Substitution only: text after `~>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inserted: Option<String>,
}

/// A highlight+comment annotation from the authoring flow. Either side may be
/// `null`: highlight-only (comment not yet typed) or comment-only (a point
/// comment with no highlight).
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, from_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    /// Overall span across whichever marks are present (UTF-16 offsets).
    pub from: usize,
    pub to: usize,
    pub highlight: Option<CriticMark>,
    pub comment: Option<CriticMark>,
}

// ASCII delimiter units (UTF-16 == byte value for ASCII).
const B_BRACE: u16 = b'{' as u16;
const B_PLUS: u16 = b'+' as u16;
const B_DASH: u16 = b'-' as u16;
const B_TILDE: u16 = b'~' as u16;
const B_GT: u16 = b'>' as u16;
const B_LT: u16 = b'<' as u16;
const B_EQ: u16 = b'=' as u16;
const B_RBRACE: u16 = b'}' as u16;

/// The opening delimiter (3 units) at `u[i..]`, and its mark kind.
fn open_at(u: &[u16], i: usize) -> Option<CriticMarkKind> {
    if i + 3 > u.len() {
        return None;
    }
    match (u[i], u[i + 1], u[i + 2]) {
        (B_BRACE, B_PLUS, B_PLUS) => Some(CriticMarkKind::Addition),
        (B_BRACE, B_DASH, B_DASH) => Some(CriticMarkKind::Deletion),
        (B_BRACE, B_TILDE, B_TILDE) => Some(CriticMarkKind::Substitution),
        (B_BRACE, B_GT, B_GT) => Some(CriticMarkKind::Comment),
        (B_BRACE, B_EQ, B_EQ) => Some(CriticMarkKind::Highlight),
        _ => None,
    }
}

/// The 3-unit closing delimiter for a mark kind.
fn close_seq(kind: CriticMarkKind) -> [u16; 3] {
    match kind {
        CriticMarkKind::Addition => [B_PLUS, B_PLUS, B_RBRACE],
        CriticMarkKind::Deletion => [B_DASH, B_DASH, B_RBRACE],
        CriticMarkKind::Substitution => [B_TILDE, B_TILDE, B_RBRACE],
        CriticMarkKind::Comment => [B_LT, B_LT, B_RBRACE],
        CriticMarkKind::Highlight => [B_EQ, B_EQ, B_RBRACE],
    }
}

/// Index of the first occurrence of `needle` in `hay` at or after `start`.
fn find_seq(hay: &[u16], start: usize, needle: &[u16]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    let mut i = start;
    while i + needle.len() <= hay.len() {
        if hay[i..i + needle.len()] == *needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Decode a UTF-16 unit slice back to a `String` (mirrors JS `slice`).
fn units_to_string(u: &[u16]) -> String {
    String::from_utf16_lossy(u)
}

/// Scan the whole doc for every CriticMarkup mark in document order
/// (non-overlapping, left-to-right). An unterminated open is NOT a mark: the
/// scan advances one unit and keeps going. Mirrors the TS `parseCriticMarks`.
pub fn parse_critic_marks(doc: &str) -> Vec<CriticMark> {
    let units: Vec<u16> = doc.encode_utf16().collect();
    let n = units.len();
    let mut marks: Vec<CriticMark> = Vec::new();
    const ARROW: [u16; 2] = [B_TILDE, B_GT];

    let mut i = 0;
    while i < n {
        if let Some(kind) = open_at(&units, i) {
            if let Some(close_idx) = find_seq(&units, i + 3, &close_seq(kind)) {
                let content_from = i + 3;
                let content_to = close_idx;
                let inner = &units[content_from..content_to];
                let mut mark = CriticMark {
                    kind,
                    from: i,
                    to: close_idx + 3,
                    content_from,
                    content_to,
                    text: None,
                    deleted: None,
                    inserted: None,
                };
                if kind == CriticMarkKind::Substitution {
                    // The FIRST `~>` splits old/new; with none present, treat the
                    // whole inner as the deleted side (TS leniency).
                    match find_seq(inner, 0, &ARROW) {
                        Some(sep) => {
                            mark.deleted = Some(units_to_string(&inner[..sep]));
                            mark.inserted = Some(units_to_string(&inner[sep + 2..]));
                        }
                        None => {
                            mark.deleted = Some(units_to_string(inner));
                            mark.inserted = Some(String::new());
                        }
                    }
                } else {
                    mark.text = Some(units_to_string(inner));
                }
                i = mark.to;
                marks.push(mark);
                continue;
            }
        }
        i += 1;
    }
    marks
}

/// Group marks into annotations. A comment mark whose `from` EQUALS the
/// preceding highlight's `to` (directly adjacent) binds to it →
/// `{highlight, comment}`. A highlight with no adjacent comment →
/// `{highlight, null}`. A comment not bound to a preceding highlight →
/// `{null, comment}` (a point comment). Addition/deletion/substitution marks are
/// not annotations and are skipped. Mirrors the TS `pairAnnotations`.
pub fn pair_annotations(marks: &[CriticMark]) -> Vec<Annotation> {
    let mut annotations: Vec<Annotation> = Vec::new();
    let mut idx = 0;
    while idx < marks.len() {
        let mark = &marks[idx];
        match mark.kind {
            CriticMarkKind::Highlight => {
                let next = marks.get(idx + 1);
                if let Some(c) = next {
                    if c.kind == CriticMarkKind::Comment && c.from == mark.to {
                        annotations.push(Annotation {
                            from: mark.from,
                            to: c.to,
                            highlight: Some(mark.clone()),
                            comment: Some(c.clone()),
                        });
                        idx += 2; // consume the bound comment
                        continue;
                    }
                }
                annotations.push(Annotation {
                    from: mark.from,
                    to: mark.to,
                    highlight: Some(mark.clone()),
                    comment: None,
                });
            }
            CriticMarkKind::Comment => {
                // A bound comment is consumed above, so this is a point comment.
                annotations.push(Annotation {
                    from: mark.from,
                    to: mark.to,
                    highlight: None,
                    comment: Some(mark.clone()),
                });
            }
            _ => {}
        }
        idx += 1;
    }
    annotations
}

/// The annotation whose overall `[from, to]` span contains `pos` (a caret
/// between chars: `from <= pos <= to`), or `None`. Mirrors the TS `annotationAt`.
pub fn annotation_at(annotations: &[Annotation], pos: usize) -> Option<Annotation> {
    annotations
        .iter()
        .find(|a| a.from <= pos && pos <= a.to)
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(m: &CriticMark) -> (usize, usize, usize, usize) {
        (m.from, m.to, m.content_from, m.content_to)
    }

    #[test]
    fn parses_addition_span_and_text() {
        let m = &parse_critic_marks("{++new++}")[0];
        assert_eq!(m.kind, CriticMarkKind::Addition);
        assert_eq!(span(m), (0, 9, 3, 6));
        assert_eq!(m.text.as_deref(), Some("new"));
    }

    #[test]
    fn parses_deletion_highlight_comment() {
        assert_eq!(parse_critic_marks("{--old--}")[0].text.as_deref(), Some("old"));
        let hl = &parse_critic_marks("{==hi==}")[0];
        assert_eq!(hl.kind, CriticMarkKind::Highlight);
        assert_eq!(span(hl), (0, 8, 3, 5));
        let co = &parse_critic_marks("{>>note<<}")[0];
        assert_eq!(co.kind, CriticMarkKind::Comment);
        assert_eq!(span(co), (0, 10, 3, 7));
        assert_eq!(co.text.as_deref(), Some("note"));
    }

    #[test]
    fn substitution_splits_on_first_arrow() {
        let m = &parse_critic_marks("{~~old~>new~~}")[0];
        assert_eq!(m.deleted.as_deref(), Some("old"));
        assert_eq!(m.inserted.as_deref(), Some("new"));
        assert!(m.text.is_none());
        let multi = &parse_critic_marks("{~~a~>b~>c~~}")[0];
        assert_eq!(multi.deleted.as_deref(), Some("a"));
        assert_eq!(multi.inserted.as_deref(), Some("b~>c"));
    }

    #[test]
    fn substitution_without_arrow_is_all_deleted() {
        let m = &parse_critic_marks("{~~only~~}")[0];
        assert_eq!(m.deleted.as_deref(), Some("only"));
        assert_eq!(m.inserted.as_deref(), Some(""));
    }

    #[test]
    fn keeps_inner_whitespace_untrimmed() {
        assert_eq!(parse_critic_marks("{== foo ==}")[0].text.as_deref(), Some(" foo "));
    }

    #[test]
    fn empty_inner_content() {
        let hi = &parse_critic_marks("{====}")[0];
        assert_eq!(hi.text.as_deref(), Some(""));
        assert_eq!((hi.content_from, hi.content_to), (3, 3));
        let co = &parse_critic_marks("{>><<}")[0];
        assert_eq!((co.content_from, co.content_to), (3, 3));
    }

    #[test]
    fn multiple_marks_document_order() {
        let ms = parse_critic_marks("a {++x++} b {>>y<<} c");
        assert_eq!(
            ms.iter().map(|m| m.kind).collect::<Vec<_>>(),
            vec![CriticMarkKind::Addition, CriticMarkKind::Comment]
        );
        assert_eq!(ms[0].from, 2);
        assert_eq!(ms[1].from, 12);
    }

    #[test]
    fn unterminated_open_ignored_but_later_mark_found() {
        assert!(parse_critic_marks("{++ no close here").is_empty());
        let ms = parse_critic_marks("{++ oops then {==real==}");
        assert_eq!(ms.len(), 1);
        assert_eq!(ms[0].text.as_deref(), Some("real"));
    }

    #[test]
    fn offsets_count_utf16_units_not_bytes() {
        // A 4-byte astral char (😀) is TWO UTF-16 units — the mark after it must
        // start at UTF-16 offset 2, not byte offset 4.
        let m = &parse_critic_marks("😀{++x++}")[0];
        assert_eq!(m.from, 2);
        assert_eq!(m.content_from, 5);
        assert_eq!(m.text.as_deref(), Some("x"));
    }

    #[test]
    fn pairs_adjacent_highlight_and_comment() {
        let marks = parse_critic_marks("{==term==}{>>see<<}");
        let anns = pair_annotations(&marks);
        assert_eq!(anns.len(), 1);
        assert!(anns[0].highlight.is_some());
        assert!(anns[0].comment.is_some());
        assert_eq!(anns[0].from, 0);
        assert_eq!(anns[0].to, marks[1].to);
    }

    #[test]
    fn non_adjacent_highlight_and_comment_are_separate() {
        let marks = parse_critic_marks("{==term==} {>>see<<}");
        let anns = pair_annotations(&marks);
        assert_eq!(anns.len(), 2);
        assert!(anns[0].comment.is_none());
        assert!(anns[1].highlight.is_none());
    }

    #[test]
    fn change_marks_are_not_annotations() {
        let anns = pair_annotations(&parse_critic_marks("{++a++}{--b--}{~~c~>d~~}"));
        assert!(anns.is_empty());
    }

    #[test]
    fn annotation_at_finds_containing_annotation() {
        let anns = pair_annotations(&parse_critic_marks("{==term==}{>>see<<}"));
        assert!(annotation_at(&anns, 0).is_some());
        assert!(annotation_at(&anns, 5).is_some());
        assert!(annotation_at(&anns, 999).is_none());
    }
}
