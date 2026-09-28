//! Citation references (citation-superscripts).
//!
//! Detection is `sunstone_shared::citations::find_citation_refs`, the same code
//! the live editor's widgets (`src/lib/editor/citations.ts`) call through wasm,
//! so the exported PDF / web render matches the editor:
//!   - an inline `[n]` that FOLLOWS a word (preceded by a non-whitespace char
//!     that is not `[`, and not trailed by `]`/`(`/`:`) → a superscript link to
//!     the citation-table row;
//!   - a line-start `[n]` (the table rows, `find_citation_defs`: after only
//!     spaces/tabs, same trailer guard, outside code) → the literal `[n]` jump
//!     TARGET carrying `id="cite-n"` (NOT superscript — a superscript row head
//!     reads wrong);
//!   - anything else → left untouched.
//!
//! A distinct PUA sentinel pair (shared plumbing with `critic.rs`, via
//! `sentinel::Sentinels`, but a DIFFERENT delimiter pair) keeps the two
//! substitution passes independent.

use sunstone_shared::citations::{find_citation_defs, find_citation_refs};

use super::sentinel::Sentinels;

const CITE_OPEN: char = '\u{E002}';
const CITE_CLOSE: char = '\u{E003}';

/// Superscript link standing in for an inline `[n]` reference.
fn citation_ref_html(num: &str) -> String {
    format!(r##"<sup class="citation-ref"><a href="#cite-{num}">[{num}]</a></sup>"##)
}

/// Literal, anchored `[n]` for a citation-table row (the jump target).
fn citation_def_html(num: &str) -> String {
    format!(r#"<a id="cite-{num}" class="citation-def">[{num}]</a>"#)
}

/// Rewrite citation markers in `body` to sentinel tokens, returning the prepared
/// body plus the sentinel replacements.
///
/// Both kinds come from the SHARED scanner (ADR 0006 family 13 — one
/// recognition, for the editor and SSR): inline REFERENCES from
/// `find_citation_refs`, line-start DEFINITIONS (table rows) from
/// `find_citation_defs` (trailer-guarded and code-aware). The two are disjoint
/// (a reference must follow a word). Offsets are UTF-16 units, so the body is
/// sliced over its UTF-16 units.
pub(super) fn citations_to_sentinels(body: &str) -> (String, Sentinels) {
    let units: Vec<u16> = body.encode_utf16().collect();
    let refs = find_citation_refs(body)
        .into_iter()
        .map(|r| (r.from, r.to, citation_ref_html(&r.num)));
    let defs = find_citation_defs(body)
        .into_iter()
        .map(|d| (d.from, d.to, citation_def_html(&d.num)));
    let mut spans: Vec<(usize, usize, String)> = refs.chain(defs).collect();
    spans.sort_unstable_by_key(|&(from, _, _)| from);

    let mut sentinels = Sentinels::new(CITE_OPEN, CITE_CLOSE);
    let mut out = String::with_capacity(body.len());
    let mut pos = 0usize;
    for (from, to, html) in spans {
        out.push_str(&String::from_utf16_lossy(&units[pos..from]));
        sentinels.push(&mut out, html);
        pos = to;
    }
    out.push_str(&String::from_utf16_lossy(&units[pos..]));
    (out, sentinels)
}

/// Substitute the citation sentinels (`\u{E002}<id>\u{E003}`) with their HTML.
pub(super) fn substitute_citation_sentinels(html: &str, sentinels: &Sentinels) -> String {
    sentinels.substitute(html)
}

#[cfg(test)]
mod tests {
    use crate::render::render_body;

    fn paths(ps: &[&str]) -> Vec<String> {
        ps.iter().map(|s| s.to_string()).collect()
    }

    fn render(body: &str, source: &str, all: &[&str]) -> crate::render::RenderPayload {
        let all = paths(all);
        let set: Vec<String> = all.clone();
        // The Embed pass needs an Attachment corpus + a shell URL mapper; neither
        // is exercised here (see `render/embeds.rs` for those tests).
        render_body(
            body,
            source,
            &all,
            &move |p| set.iter().any(|x| x == p),
            &[],
            &|p| p.to_string(),
        )
    }

    #[test]
    fn inline_citation_becomes_superscript_link() {
        let p = render("deepen umami and body.[6][7][8]\n", "a.md", &["a.md"]);
        // Each reference is its own superscript link to the matching row, with
        // the `[n]` brackets kept around the clickable number.
        assert!(p
            .html
            .contains(r##"<sup class="citation-ref"><a href="#cite-6">[6]</a></sup>"##));
        assert!(p.html.contains(r##"href="#cite-7">[7]<"##));
        assert!(p.html.contains(r##"href="#cite-8">[8]<"##));
        // comrak's stray URL-less reference link is gone — the only `[7]` left is
        // the one inside our superscript anchor, never bare text.
        assert!(!p.html.contains(">[7]</a></sup>[7]"));
    }

    #[test]
    fn citation_table_row_is_literal_anchor_not_superscript() {
        let p = render("body.[6]\n\n[6] Kokumi source. https://x.y\n", "a.md", &["a.md"]);
        // The table row keeps literal `[6]` and carries the jump-target id.
        assert!(p
            .html
            .contains(r#"<a id="cite-6" class="citation-def">[6]</a>"#));
        // …and is NOT wrapped in a superscript.
        assert!(!p.html.contains(r##"<sup class="citation-ref"><a href="#cite-6">[6]</a></sup> Kokumi"##));
    }

    #[test]
    fn bracketed_number_not_following_a_word_is_left_alone() {
        // Space-preceded `[6]` is neither a reference nor a table row: untouched.
        let p = render("a paragraph [6] mid-sentence\n", "a.md", &["a.md"]);
        assert!(p.html.contains("[6]"));
        assert!(!p.html.contains("citation-ref"));
        assert!(!p.html.contains("citation-def"));
    }

    #[test]
    fn line_start_numbered_link_stays_a_link() {
        // `[1](url)` is a markdown link, not a citation-table row.
        let p = render("[1](https://x.example)\n", "a.md", &["a.md"]);
        assert!(p.html.contains(r#"href="https://x.example""#), "{}", p.html);
        assert!(!p.html.contains("citation-def"), "{}", p.html);
        assert!(!p.html.contains("(https://x.example)"), "{}", p.html);
    }

    #[test]
    fn line_start_reference_definition_is_not_consumed() {
        // `[1]: url` is a reference definition; `[text][1]` must still resolve.
        let p = render("See [the source][1].\n\n[1]: https://x.example\n", "a.md", &["a.md"]);
        assert!(p.html.contains(r#"href="https://x.example""#), "{}", p.html);
        assert!(!p.html.contains("citation-def"), "{}", p.html);
    }

    #[test]
    fn line_start_bracket_number_in_fenced_code_is_left_alone() {
        let p = render("```\n[1] not a row\n```\n", "a.md", &["a.md"]);
        assert!(!p.html.contains("citation-def"), "{}", p.html);
        assert!(p.html.contains("[1] not a row"), "{}", p.html);
    }

    #[test]
    fn only_space_or_tab_indents_a_definition() {
        // A no-break space is not row indentation (the shared rule: spaces/tabs).
        let p = render("\u{a0}[1] not a row\n", "a.md", &["a.md"]);
        assert!(!p.html.contains("citation-def"), "{}", p.html);
        let p = render("\t[1] tab-indented row\n", "a.md", &["a.md"]);
        assert!(p.html.contains(r#"id="cite-1""#), "{}", p.html);
    }
}
