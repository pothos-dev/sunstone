//! Footnotes (ov-14).
//!
//! Detection is `sunstone_shared::footnotes::scan_footnotes`, the same code the
//! editor's widgets (`src/lib/editor/footnotes.ts`) call through wasm:
//!   - a `[^label]` reference → a superscript `[label]` link to the definition,
//!     or a non-link `broken` superscript when the label has no definition;
//!   - a line-start `[^label]:` definition → a `[label]` row head carrying
//!     `id="fn-label"` (the jump target); the footnote text after it stays
//!     ordinary markdown, rendered where it was written.
//!
//! comrak's own `extension.footnotes` is deliberately not used: it renumbers by
//! first use and moves definitions to an end section, which would disagree
//! with the editor. Consecutive definition lines would otherwise merge into one
//! paragraph, so a definition directly under another gets a leading `<br>`.
//!
//! A distinct PUA sentinel pair (shared plumbing via `sentinel::Sentinels`)
//! keeps this pass independent of the CriticMarkup and citation passes.

use sunstone_shared::footnotes::scan_footnotes;

use super::attr_escape;
use super::sentinel::Sentinels;

const FN_OPEN: char = '\u{E004}';
const FN_CLOSE: char = '\u{E005}';

fn footnote_ref_html(label: &str, defined: bool) -> String {
    let l = attr_escape(label);
    if defined {
        format!(r##"<sup class="footnote-ref"><a href="#fn-{l}">[{l}]</a></sup>"##)
    } else {
        format!(r#"<sup class="footnote-ref broken">[{l}]</sup>"#)
    }
}

fn footnote_def_html(label: &str, after_def: bool) -> String {
    let l = attr_escape(label);
    let br = if after_def { "<br>" } else { "" };
    format!(r#"{br}<a id="fn-{l}" class="footnote-def">[{l}]</a>"#)
}

/// Rewrite footnote markers in `body` to sentinel tokens, returning the prepared
/// body plus the sentinel replacements. Offsets are UTF-16 units, so the body
/// is sliced over its UTF-16 units.
pub(super) fn footnotes_to_sentinels(body: &str) -> (String, Sentinels) {
    let units: Vec<u16> = body.encode_utf16().collect();
    let newline = u16::from(b'\n');
    let mut sentinels = Sentinels::new(FN_OPEN, FN_CLOSE);
    let mut out = String::with_capacity(body.len());
    let mut pos = 0usize;
    // UTF-16 offset of the line after the last definition seen.
    let mut next_line_after_def: Option<usize> = None;
    for f in scan_footnotes(body) {
        out.push_str(&String::from_utf16_lossy(&units[pos..f.from]));
        let html = if f.def {
            let line_start = units[..f.from]
                .iter()
                .rposition(|&u| u == newline)
                .map_or(0, |p| p + 1);
            let after_def = next_line_after_def == Some(line_start);
            next_line_after_def = units[f.to..]
                .iter()
                .position(|&u| u == newline)
                .map(|p| f.to + p + 1);
            footnote_def_html(&f.label, after_def)
        } else {
            footnote_ref_html(&f.label, f.defined)
        };
        sentinels.push(&mut out, html);
        pos = f.to;
    }
    out.push_str(&String::from_utf16_lossy(&units[pos..]));
    (out, sentinels)
}

#[cfg(test)]
mod tests {
    use crate::render::render_body;

    fn render(body: &str) -> String {
        let all = vec!["a.md".to_string()];
        render_body(body, "a.md", &all, &|p| p == "a.md", &[], &|p| p.to_string()).html
    }

    #[test]
    fn reference_links_to_its_definition() {
        let html = render("Claim [^2] here.\n\n[^2]: The source.\n");
        assert!(
            html.contains(r##"Claim <sup class="footnote-ref"><a href="#fn-2">[2]</a></sup> here."##),
            "{html}"
        );
        assert!(
            html.contains(r#"<p><a id="fn-2" class="footnote-def">[2]</a> The source.</p>"#),
            "{html}"
        );
    }

    #[test]
    fn dangling_reference_is_broken_and_unlinked() {
        let html = render("Claim[^9].\n");
        assert!(html.contains(r#"<sup class="footnote-ref broken">[9]</sup>"#), "{html}");
        assert!(!html.contains("#fn-9"), "{html}");
    }

    #[test]
    fn consecutive_definitions_break_onto_their_own_lines() {
        let html = render("x[^1][^2]\n\n[^1]: one\n[^2]: two\n");
        assert!(html.contains("one\n<br><a id=\"fn-2\""), "{html}");
        assert!(!html.contains(r#"<br><a id="fn-1""#), "{html}");
    }

    #[test]
    fn url_definition_is_not_swallowed_as_a_link_reference() {
        // `[^1]: https://x` is a link reference definition to plain comrak; the
        // sentinel pass consumes the marker first, so the URL stays visible.
        let html = render("x[^1]\n\n[^1]: https://x.example\n");
        assert!(html.contains(r#"<a id="fn-1" class="footnote-def">[1]</a>"#), "{html}");
        assert!(html.contains("https://x.example"), "{html}");
    }

    #[test]
    fn labels_are_escaped() {
        let html = render("x[^a\"<b]\n");
        assert!(html.contains(r#"[a&quot;&lt;b]"#), "{html}");
        assert!(!html.contains(r#"a"<b"#), "{html}");
    }

    #[test]
    fn code_is_left_alone() {
        let html = render("`[^1]`\n\n```\n[^1]: x\n```\n");
        assert!(!html.contains("footnote"), "{html}");
    }

    #[test]
    fn citations_still_render_alongside() {
        let html = render("a.[6] b[^1]\n\n[6] row\n[^1]: note\n");
        assert!(html.contains(r##"href="#cite-6""##), "{html}");
        assert!(html.contains(r##"href="#fn-1""##), "{html}");
    }
}
