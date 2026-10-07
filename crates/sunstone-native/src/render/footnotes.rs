//! Footnotes (ov-14) and the Sources section (ov-17).
//!
//! Detection is `sunstone_shared::footnotes::scan_footnotes`, the same code the
//! editor's widgets (`src/lib/editor/footnotes.ts`) call through wasm:
//!   - a `[^label]` reference → a superscript `n` (its number by first use; a
//!     comma before one that directly follows another, `1,2`). A label that is
//!     a `sources[].id` links straight to that entry's `resource` (an in-Bundle
//!     Concept or an external URL), and stays unlinked when the resource is a
//!     scope descriptor. It carries the entry as `data-source` JSON, which the
//!     web viewer's hover card reads (`src/lib/sourceCard.ts`). Any other label links
//!     to its body definition, or is a non-link `broken` one without one;
//!   - a line-start `[^label]:` definition → an `n` row head carrying
//!     `id="fn-label"` (the jump target); the footnote text after it stays
//!     ordinary markdown, rendered where it was written.
//!
//! The Sources section (`sources_section_html`) lists the `sources` entries at
//! the end of the body, numbered like their superscripts
//! (`sunstone_shared::sources::source_list`). It exists only in the render,
//! never in the file.
//!
//! comrak's own `extension.footnotes` is deliberately not used: it renumbers by
//! first use and moves definitions to an end section, which would disagree
//! with the editor. Consecutive definition lines would otherwise merge into one
//! paragraph, so a definition directly under another gets a leading `<br>`.
//!
//! A distinct PUA sentinel pair (shared plumbing via `sentinel::Sentinels`)
//! keeps this pass independent of the CriticMarkup and citation passes.

use sunstone_shared::footnotes::{scan_footnotes, Footnote};
use sunstone_shared::sources::{ResourceKind, Source};

use super::attr_escape;
use super::sentinel::Sentinels;

const FN_OPEN: char = '\u{E004}';
const FN_CLOSE: char = '\u{E005}';

/// Maps a followable `resource` to the attributes of an `<a>` opening it
/// (`href` plus the internal/external link classes the viewer acts on).
pub(super) type LinkAttrs<'a> = &'a dyn Fn(&str) -> String;

/// The `fn-…` anchor for `label`. Labels match case-insensitively, so the
/// anchor is lowercased while the label is shown as written.
fn footnote_anchor(label: &str) -> String {
    attr_escape(&label.to_lowercase())
}

/// `data-source="…"`: the entry as JSON (the wasm `Source` shape) for the
/// hover card.
fn source_data(s: &Source) -> String {
    let json = serde_json::to_string(s).unwrap_or_default();
    format!(r#"data-source="{}""#, attr_escape(&json))
}

/// The `sources` entry a label cites, if any (first entry with the id).
fn source_for<'s>(sources: &'s [Source], label: &str) -> Option<&'s Source> {
    let wanted = label.to_lowercase();
    sources
        .iter()
        .find(|s| s.id.as_deref().is_some_and(|id| id.to_lowercase() == wanted))
}

fn footnote_ref_html(f: &Footnote, source: Option<&Source>, link: LinkAttrs) -> String {
    let (l, n) = (attr_escape(&f.label), f.num);
    let sep = if f.follows_ref { "," } else { "" };
    if let Some(s) = source {
        let d = source_data(s);
        if s.kind == ResourceKind::Descriptor {
            format!(r#"<sup class="footnote-ref source" {d}>{sep}{n}</sup>"#)
        } else {
            let a = link(&s.resource);
            format!(r#"<sup class="footnote-ref source" {d}>{sep}<a {a}>{n}</a></sup>"#)
        }
    } else if f.has_def {
        let a = footnote_anchor(&f.label);
        format!(r##"<sup class="footnote-ref" title="{l}">{sep}<a href="#fn-{a}">{n}</a></sup>"##)
    } else if f.defined {
        format!(r#"<sup class="footnote-ref" title="{l}">{sep}{n}</sup>"#)
    } else {
        format!(r#"<sup class="footnote-ref broken" title="{l}">{sep}{n}</sup>"#)
    }
}

fn footnote_def_html(f: &Footnote, after_def: bool) -> String {
    let (l, n) = (attr_escape(&f.label), f.num);
    let a = footnote_anchor(&f.label);
    let br = if after_def { "<br>" } else { "" };
    format!(r#"{br}<a id="fn-{a}" class="footnote-def" title="{l}">{n}</a>"#)
}

/// Rewrite footnote markers in `body` to sentinel tokens, returning the prepared
/// body plus the sentinel replacements. `sources` are the Concept's `sources`
/// entries, numbered (`source_list`); `link` builds the anchor attributes for a followable resource.
/// Offsets are UTF-16 units, so the body is sliced over its UTF-16 units.
pub(super) fn footnotes_to_sentinels(
    body: &str,
    sources: &[Source],
    link: LinkAttrs,
) -> (String, Sentinels) {
    let units: Vec<u16> = body.encode_utf16().collect();
    let newline = u16::from(b'\n');
    let ids: Vec<String> = sources.iter().filter_map(|s| s.id.clone()).collect();
    let mut sentinels = Sentinels::new(FN_OPEN, FN_CLOSE);
    let mut out = String::with_capacity(body.len());
    let mut pos = 0usize;
    // UTF-16 offset of the line after the last definition seen.
    let mut next_line_after_def: Option<usize> = None;
    for f in scan_footnotes(body, &ids) {
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
            footnote_def_html(&f, after_def)
        } else {
            footnote_ref_html(&f, source_for(sources, &f.label), link)
        };
        sentinels.push(&mut out, html);
        pos = f.to;
    }
    out.push_str(&String::from_utf16_lossy(&units[pos..]));
    (out, sentinels)
}

/// The Sources section for `list` (from `source_list`), or `""` when the
/// Concept has no `sources`. Each entry shows its number (blank when uncited),
/// its title (or resource) as a link to the resource when followable, and the
/// resource below it.
pub(super) fn sources_section_html(list: &[Source], link: LinkAttrs) -> String {
    if list.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        r#"<section class="sources"><div class="sources-heading">Sources</div><ol class="sources-list">"#,
    );
    for s in list {
        let num = s.num.map(|n| n.to_string()).unwrap_or_default();
        let d = source_data(s);
        let label = attr_escape(s.title.as_deref().unwrap_or(&s.resource));
        let title = if s.kind == ResourceKind::Descriptor {
            format!(r#"<span class="source-title" {d}>{label}</span>"#)
        } else {
            format!(r#"<a {} {d}><span class="source-title">{label}</span></a>"#, link(&s.resource))
        };
        let resource = if s.title.is_some() && !s.resource.is_empty() {
            format!(r#"<span class="source-resource">{}</span>"#, attr_escape(&s.resource))
        } else {
            String::new()
        };
        out.push_str(&format!(
            r#"<li><span class="source-num">{num}</span><span class="source-body">{title}{resource}</span></li>"#
        ));
    }
    out.push_str("</ol></section>");
    out
}

#[cfg(test)]
mod tests {
    use crate::render::render_body;

    fn render_in(body: &str, path: &str, all: &[&str]) -> String {
        let all: Vec<String> = all.iter().map(|s| s.to_string()).collect();
        render_body(body, path, &all, &|p| all.iter().any(|a| a == p), &[], &|p| p.to_string()).html
    }

    fn render(body: &str) -> String {
        let all = vec!["a.md".to_string()];
        render_body(body, "a.md", &all, &|p| p == "a.md", &[], &|p| p.to_string()).html
    }

    #[test]
    fn reference_links_to_its_definition() {
        let html = render("Claim [^2] here.\n\n[^2]: The source.\n");
        assert!(
            html.contains(r##"Claim <sup class="footnote-ref" title="2"><a href="#fn-2">1</a></sup> here."##),
            "{html}"
        );
        assert!(
            html.contains(r#"<p><a id="fn-2" class="footnote-def" title="2">1</a> The source.</p>"#),
            "{html}"
        );
    }

    #[test]
    fn dangling_reference_is_broken_and_unlinked() {
        let html = render("Claim[^9].\n");
        assert!(html.contains(r#"<sup class="footnote-ref broken" title="9">1</sup>"#), "{html}");
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
        assert!(html.contains(r#"<a id="fn-1" class="footnote-def" title="1">1</a>"#), "{html}");
        assert!(html.contains("https://x.example"), "{html}");
    }

    #[test]
    fn mixed_case_labels_share_one_anchor() {
        let html = render("x[^Src]\n\n[^src]: s\n");
        assert!(html.contains(r##"<a href="#fn-src">1</a>"##), "{html}");
        assert!(html.contains(r#"<a id="fn-src" class="footnote-def" title="src">1</a>"#), "{html}");
    }

    #[test]
    fn labels_are_escaped() {
        let html = render("x[^a\"<b]\n");
        assert!(html.contains(r#"title="a&quot;&lt;b""#), "{html}");
        assert!(!html.contains(r#"a"<b"#), "{html}");
    }

    #[test]
    fn string_labels_number_by_first_use_and_sources_resolve_them() {
        let body = "---\ntype: N\nsources:\n  - id: ssi-web\n    resource: https://x\n---\n\nA[^phase-1] B[^ssi-web] C[^phase-1]\n\n[^phase-1]: Brief\n";
        let html = render(body);
        assert!(html.contains(r##"A<sup class="footnote-ref" title="phase-1"><a href="#fn-phase-1">1</a></sup>"##), "{html}");
        // `ssi-web` has no body definition but is a `sources` id: it links to the resource.
        assert!(html.contains(r#"B<sup class="footnote-ref source" data-source="{&quot;id&quot;:&quot;ssi-web&quot;"#), "{html}");
        assert!(html.contains(r#"<a href="https://x" target="_blank" rel="noopener noreferrer">2</a></sup>"#), "{html}");
        assert!(html.contains(r##"C<sup class="footnote-ref" title="phase-1"><a href="#fn-phase-1">1</a>"##), "{html}");
        assert!(!html.contains("broken"), "{html}");
    }

    #[test]
    fn adjacent_references_get_a_comma() {
        let html = render("x[^a][^b] y[^a]\n\n[^a]: A\n[^b]: B\n");
        assert!(html.contains(r##"<a href="#fn-a">1</a></sup><sup class="footnote-ref" title="b">,<a href="#fn-b">2</a>"##), "{html}");
        assert!(html.contains(r##"y<sup class="footnote-ref" title="a"><a href="#fn-a">1</a>"##), "{html}");
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

    const WITH_SOURCES: &str = "---\ntype: N\nsources:\n  - id: spec\n    resource: /docs/spec.md\n    title: The spec\n  - id: web\n    resource: https://x.example/a?b=1&c=2\n  - id: scope\n    resource: all queries in project X\n  - id: unused\n    resource: ../u.md\n---\n\nA[^web] B[^spec][^scope] C[^web].\n";

    #[test]
    fn source_footnotes_link_to_the_resource() {
        let html = render_in(WITH_SOURCES, "notes/a.md", &["notes/a.md", "docs/spec.md"]);
        // The entry rides along as JSON (the wasm `Source` shape) for the hover card.
        let web = r#"data-source="{&quot;id&quot;:&quot;web&quot;,&quot;resource&quot;:&quot;https://x.example/a?b=1&amp;c=2&quot;,&quot;kind&quot;:&quot;url&quot;,&quot;title&quot;:null,&quot;author&quot;:null,&quot;usageCount&quot;:null,&quot;lastModified&quot;:null,&quot;num&quot;:1}""#;
        assert!(
            html.contains(&format!(r#"A<sup class="footnote-ref source" {web}><a href="https://x.example/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">1</a></sup>"#)),
            "{html}"
        );
        assert!(
            html.contains(r#"&quot;num&quot;:2}"><a class="internal-link" data-path="docs/spec.md""#),
            "{html}"
        );
        // A scope descriptor is resolved but not a link.
        assert!(html.contains(r#"&quot;num&quot;:3}">,3</sup>"#), "{html}");
        assert!(!html.contains(" title=\"all queries"), "{html}");
    }

    #[test]
    fn sources_section_lists_cited_then_uncited() {
        let html = render_in(WITH_SOURCES, "notes/a.md", &["notes/a.md", "docs/spec.md"]);
        let section = &html[html.find(r#"<section class="sources">"#).expect("section")..];
        let order: Vec<usize> = ["x.example", "The spec", "all queries", "../u.md"]
            .iter()
            .map(|n| section.find(n).unwrap_or_else(|| panic!("{n} in {section}")))
            .collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]), "{section}");
        assert!(section.contains(r#"<li><span class="source-num">2</span><span class="source-body"><a class="internal-link" data-path="docs/spec.md""#), "{section}");
        assert!(section.contains(r#"<span class="source-title" data-source="{&quot;id&quot;:&quot;scope&quot;"#), "{section}");
        assert!(section.contains(r#"&quot;num&quot;:3}">all queries in project X</span>"#), "{section}");
        // `../u.md` from `notes/a.md` is `u.md`, which does not exist.
        assert!(section.contains(r#"<li><span class="source-num"></span><span class="source-body"><a class="internal-link broken" data-path="u.md""#), "{section}");
    }

    #[test]
    fn no_sources_no_section() {
        assert!(!render("x[^1]\n\n[^1]: one\n").contains("sources"));
    }
}
