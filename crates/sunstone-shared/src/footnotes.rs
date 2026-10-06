//! Markdown footnote detection (`[^label]` / `[^label]: …`).
//!
//! The ONE recognition of footnotes for the editor (CodeMirror decorations over
//! wasm, `src/lib/editor/footnotes.ts`) and the native render's sentinel pass
//! (`sunstone-native/src/render/footnotes.rs`), so both shells agree on what a
//! footnote is (ADR 0006).
//!
//! - A **definition** is a `[^label]:` at the start of a line (after at most
//!   three spaces, as in GFM). Its span covers the marker through the `:`; the
//!   footnote text after it stays ordinary markdown.
//! - A **reference** is any other `[^label]`, unless it is preceded by `[` (a
//!   wikilink) or followed by `(` (a markdown link).
//! - A label is one or more characters that are not whitespace, `[` or `]`.
//!   Labels match case-insensitively, as in GFM.
//! - Both are skipped inside fenced code blocks and inline code spans (the
//!   shared [`crate::scan`] code contract).
//!
//! Labels are reported as written: Sunstone does not renumber footnotes.
//!
//! **Offsets are UTF-16 code units**, the unit CodeMirror positions count in.

use serde::{Deserialize, Serialize};

use crate::scan::{walk_code, CodeClass};

/// A footnote reference or definition: its marker span (UTF-16 offsets) and
/// label.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Footnote {
    /// Offset of the `[` (inclusive), UTF-16 units into the scanned text.
    pub from: usize,
    /// Offset just past the marker: the `]` for a reference, the `:` for a
    /// definition (exclusive).
    pub to: usize,
    /// The label as written, without `[^` / `]` (e.g. `"2"`).
    pub label: String,
    /// `true` for a `[^label]:` definition, `false` for a reference.
    pub def: bool,
    /// Whether the label has a definition somewhere in the text. Always `true`
    /// for a definition; `false` marks a dangling reference.
    pub defined: bool,
}

/// Every footnote reference and definition in `text`, in document order.
pub fn scan_footnotes(text: &str) -> Vec<Footnote> {
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

    // Byte offset → UTF-16 offset, valid at every char boundary.
    let mut utf16_at = vec![0usize; bytes.len() + 1];
    let mut unit = 0usize;
    for (b, ch) in text.char_indices() {
        utf16_at[b] = unit;
        unit += ch.len_utf16();
    }
    utf16_at[bytes.len()] = unit;

    let mut found: Vec<(usize, usize, &str, bool)> = Vec::new();
    let mut i = 0usize;
    while i + 1 < bytes.len() {
        if bytes[i] != b'[' || bytes[i + 1] != b'^' || in_code[i] {
            i += 1;
            continue;
        }
        let Some(close) = label_end(text, i + 2) else {
            i += 1;
            continue;
        };
        let label = &text[i + 2..close];
        let after = close + 1;
        if bytes.get(after) == Some(&b':') && at_line_start(bytes, i) {
            found.push((i, after + 1, label, true));
            i = after + 1;
            continue;
        }
        let preceded_by_bracket = i > 0 && bytes[i - 1] == b'[';
        let followed_by_paren = bytes.get(after) == Some(&b'(');
        if !preceded_by_bracket && !followed_by_paren {
            found.push((i, after, label, false));
        }
        i = after;
    }

    let defined: Vec<String> = found
        .iter()
        .filter(|f| f.3)
        .map(|f| f.2.to_lowercase())
        .collect();
    found
        .into_iter()
        .map(|(from, to, label, def)| Footnote {
            from: utf16_at[from],
            to: utf16_at[to],
            label: label.to_string(),
            def,
            defined: def || defined.contains(&label.to_lowercase()),
        })
        .collect()
}

/// UTF-16 offset of the first definition of `label` (case-insensitive), or
/// `None`. The editor's jump target.
pub fn footnote_def_pos(text: &str, label: &str) -> Option<usize> {
    let wanted = label.to_lowercase();
    scan_footnotes(text)
        .into_iter()
        .find(|f| f.def && f.label.to_lowercase() == wanted)
        .map(|f| f.from)
}

/// The byte offset of the `]` closing a label that starts at `start`, when the
/// label is non-empty and free of whitespace and brackets.
fn label_end(text: &str, start: usize) -> Option<usize> {
    for (off, ch) in text[start..].char_indices() {
        match ch {
            ']' if off > 0 => return Some(start + off),
            ']' | '[' => return None,
            c if c.is_whitespace() => return None,
            _ => {}
        }
    }
    None
}

/// Whether byte `i` is preceded on its line by at most three spaces only.
fn at_line_start(bytes: &[u8], i: usize) -> bool {
    let line_start = bytes[..i].iter().rposition(|&b| b == b'\n').map_or(0, |p| p + 1);
    let indent = &bytes[line_start..i];
    indent.len() <= 3 && indent.iter().all(|&b| b == b' ')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spans(text: &str) -> Vec<(String, bool, bool)> {
        scan_footnotes(text)
            .into_iter()
            .map(|f| (f.label, f.def, f.defined))
            .collect()
    }

    fn s(label: &str, def: bool, defined: bool) -> (String, bool, bool) {
        (label.to_string(), def, defined)
    }

    #[test]
    fn reference_and_definition() {
        let text = "Claim [^2] here.\n\n[^2]: The source.\n";
        let f = scan_footnotes(text);
        assert_eq!(f.len(), 2);
        assert_eq!((f[0].from, f[0].to, f[0].def, f[0].defined), (6, 10, false, true));
        assert_eq!(f[0].label, "2");
        // `[^2]:` at offset 18, span through the colon.
        assert_eq!((f[1].from, f[1].to, f[1].def), (18, 23, true));
    }

    #[test]
    fn references_with_or_without_a_space_and_adjacent() {
        assert_eq!(
            spans("a [^1][^2] b[^3]"),
            vec![s("1", false, false), s("2", false, false), s("3", false, false)]
        );
    }

    #[test]
    fn dangling_reference_is_not_defined() {
        assert_eq!(
            spans("x[^1] y[^9]\n[^1]: one\n"),
            vec![s("1", false, true), s("9", false, false), s("1", true, true)]
        );
    }

    #[test]
    fn labels_match_case_insensitively_and_keep_their_spelling() {
        assert_eq!(spans("x[^Src]\n[^src]: s\n"), vec![s("Src", false, true), s("src", true, true)]);
        assert_eq!(footnote_def_pos("x[^Src]\n[^src]: s\n", "SRC"), Some(8));
    }

    #[test]
    fn definition_needs_line_start_and_colon() {
        // Up to three spaces of indent.
        assert_eq!(spans("   [^1]: def"), vec![s("1", true, true)]);
        // Four spaces is indented code in GFM, a tab likewise: a reference.
        assert_eq!(spans("    [^1]: x"), vec![s("1", false, false)]);
        // Mid-line `[^1]:` is a reference followed by a colon.
        assert_eq!(spans("see [^1]: x"), vec![s("1", false, false)]);
    }

    #[test]
    fn invalid_labels_are_ignored() {
        assert!(spans("[^] [^a b] [^a[b]").is_empty());
        assert!(spans("unclosed [^abc").is_empty());
    }

    #[test]
    fn links_and_wikilinks_are_not_references() {
        assert!(spans("[^1](https://x)").is_empty());
        assert!(spans("[[^1]]").is_empty());
    }

    #[test]
    fn code_is_skipped() {
        assert!(spans("`[^1]`").is_empty());
        assert!(spans("```\n[^1]: x\ny[^1]\n```\n").is_empty());
        assert_eq!(spans("```\n[^1]\n```\nz[^2]"), vec![s("2", false, false)]);
    }

    #[test]
    fn citation_brackets_are_not_footnotes() {
        assert!(spans("body.[6][7]\n[6] row\n").is_empty());
    }

    #[test]
    fn offsets_are_utf16_units() {
        let f = scan_footnotes("😀ü[^1]");
        // 😀 = 2 units, ü = 1 → `[` at 3.
        assert_eq!((f[0].from, f[0].to), (3, 7));
        let f = scan_footnotes("x\n[^ö]: y");
        assert_eq!((f[0].from, f[0].to, f[0].label.as_str()), (2, 7, "ö"));
    }

    #[test]
    fn def_pos_finds_the_first_definition() {
        let text = "x[^1]\n\n[^1]: a\n[^1]: b\n";
        assert_eq!(footnote_def_pos(text, "1"), Some(7));
        assert_eq!(footnote_def_pos(text, "2"), None);
    }
}
