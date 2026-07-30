//! Citation references (citation-superscripts).
//!
//! Mirrors the pure TS rules in `src/lib/citations.ts` so the exported PDF / web
//! render matches the live editor:
//!   - an inline `[n]` that FOLLOWS a word (preceded by a non-whitespace char
//!     that is not `[`, and not trailed by `]`/`(`/`:`) → a superscript link to
//!     the citation-table row;
//!   - a line-start `[n]` (the table rows) → the literal `[n]` jump TARGET
//!     carrying `id="cite-n"` (NOT superscript — a superscript row head reads
//!     wrong);
//!   - anything else → left untouched.
//! A distinct PUA sentinel pair (shared plumbing with `critic.rs`, via
//! `sentinel::Sentinels`, but a DIFFERENT delimiter pair) keeps the two
//! substitution passes independent.

use std::collections::HashMap;

use sunstone_shared::citations::find_citation_refs;

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
/// Inline REFERENCES come from the SHARED `find_citation_refs` (ADR 0006 family
/// 13 — one recognition of what a reference is, for the editor and SSR). The
/// line-start DEFINITIONS (table rows) are not references (the shared scan
/// excludes them), so they are detected here; the two are disjoint. Offsets from
/// the shared scan are UTF-16 units, so the body is walked over its UTF-16 units.
pub(super) fn citations_to_sentinels(body: &str) -> (String, Sentinels) {
    let units: Vec<u16> = body.encode_utf16().collect();
    let n = units.len();
    // Inline references keyed by their `[` offset (UTF-16 units).
    let refs: HashMap<usize, (usize, String)> = find_citation_refs(body)
        .into_iter()
        .map(|r| (r.from, (r.to, r.num)))
        .collect();

    let mut sentinels = Sentinels::new(CITE_OPEN, CITE_CLOSE);
    let mut out = String::with_capacity(body.len());

    let decode = |a: usize, b: usize| String::from_utf16_lossy(&units[a..b]);
    const L_BRACKET: u16 = b'[' as u16;
    const R_BRACKET: u16 = b']' as u16;
    const NEWLINE: u16 = b'\n' as u16;
    let is_digit = |u: u16| (b'0' as u16..=b'9' as u16).contains(&u);
    let is_ws = |u: u16| char::from_u32(u as u32).is_some_and(|c| c.is_whitespace());

    let mut pos = 0usize;
    let mut i = 0usize;
    while i < n {
        // Inline reference (shared recognition): superscript link.
        if let Some((to, num)) = refs.get(&i) {
            out.push_str(&decode(pos, i));
            sentinels.push(&mut out, citation_ref_html(num));
            i = *to;
            pos = i;
            continue;
        }
        // Line-start `[n]` definition (table row): literal anchored jump target.
        if units[i] == L_BRACKET {
            let mut j = i + 1;
            while j < n && is_digit(units[j]) {
                j += 1;
            }
            if j > i + 1 && j < n && units[j] == R_BRACKET {
                // At line start iff only whitespace back to the newline / start.
                let mut k = i;
                let mut at_line_start = true;
                while k > 0 {
                    let c = units[k - 1];
                    if c == NEWLINE {
                        break;
                    }
                    if !is_ws(c) {
                        at_line_start = false;
                        break;
                    }
                    k -= 1;
                }
                if at_line_start {
                    let num = decode(i + 1, j);
                    out.push_str(&decode(pos, i));
                    sentinels.push(&mut out, citation_def_html(&num));
                    i = j + 1;
                    pos = i;
                    continue;
                }
            }
        }
        i += 1;
    }
    out.push_str(&decode(pos, n));
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
        render_body(body, source, &all, &move |p| set.iter().any(|x| x == p))
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
}
