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
//!   - a line-start `[^label]:` definition → an `n` row head; the label's first
//!     definition carries `id="fn-label"` (the jump target, matching the
//!     editor's `footnote_def_pos`), later duplicates none. The footnote text
//!     after it stays ordinary markdown, rendered where it was written.
//!
//! The Sources section (`sources_section_html`) lists the `sources` entries at
//! the end of the body, numbered like their superscripts
//! (`sunstone_shared::sources::source_list`). It exists only in the render,
//! never in the file. Each entry shows its credibility signals as written
//! (`author` as an actor, `last_modified`, `usage_count` over its
//! `usage_window`), the text of a body definition for its id, and a jump back
//! to every claim citing it: a source reference carries `id="fnref-label-k"`
//! (k counting that label's references from 1) and the entry links to each
//! (ov-10). A body `[^id]: …` definition for a `sources` id is dropped from the
//! body; its text shows on the entry instead.
//!
//! comrak's own `extension.footnotes` is deliberately not used: it renumbers by
//! first use and moves definitions to an end section, which would disagree
//! with the editor. A definition line directly under any non-blank line would
//! otherwise merge into that paragraph, so it gets a leading `<br>`.
//!
//! A distinct PUA sentinel pair (shared plumbing via `sentinel::Sentinels`)
//! keeps this pass independent of the CriticMarkup and citation passes.

use std::collections::{HashMap, HashSet};

use sunstone_shared::actor::{parse_actor, ActorKind};
use sunstone_shared::footnotes::{scan_footnotes, Footnote};
use sunstone_shared::sources::{ResourceKind, Source, UsageWindow};

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

/// The id of the `k`-th (1-based) reference to `label` that cites a source:
/// where its Sources entry jumps back to.
fn backref_id(label: &str, k: usize) -> String {
    format!("fnref-{}-{k}", footnote_anchor(label))
}

/// A reference; `source` is the entry it cites and its count `k` among that
/// label's references.
fn footnote_ref_html(f: &Footnote, source: Option<(&Source, usize)>, link: LinkAttrs) -> String {
    let (l, n) = (attr_escape(&f.label), f.num);
    let sep = if f.follows_ref { "," } else { "" };
    if let Some((s, k)) = source {
        let d = source_data(s);
        let id = backref_id(&f.label, k);
        if s.kind == ResourceKind::Descriptor {
            format!(r#"<sup id="{id}" class="footnote-ref source" {d}>{sep}{n}</sup>"#)
        } else {
            let a = link(&s.resource);
            format!(r#"<sup id="{id}" class="footnote-ref source" {d}>{sep}<a {a}>{n}</a></sup>"#)
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

/// A definition's row head. `first` marks the label's first definition, the
/// only one carrying the `fn-…` anchor (the editor's jump target too); `br`
/// starts it on its own line when it sits directly under a non-blank line.
fn footnote_def_html(f: &Footnote, first: bool, br: bool) -> String {
    let (l, n) = (attr_escape(&f.label), f.num);
    let id = if first { format!(r#"id="fn-{}" "#, footnote_anchor(&f.label)) } else { String::new() };
    let br = if br { "<br>" } else { "" };
    format!(r#"{br}<a {id}class="footnote-def" title="{l}">{n}</a>"#)
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
    // Lowercased labels whose first definition has been emitted.
    let mut anchored: HashSet<String> = HashSet::new();
    // Source references seen so far, per lowercased label.
    let mut cited: HashMap<String, usize> = HashMap::new();
    for f in scan_footnotes(body, &ids) {
        out.push_str(&String::from_utf16_lossy(&units[pos..f.from]));
        let source = source_for(sources, &f.label);
        if f.def && source.is_some() {
            // Its text shows on the Sources entry; the line itself goes.
            pos = units[f.to..]
                .iter()
                .position(|&u| u == newline)
                .map_or(units.len(), |p| f.to + p);
            continue;
        }
        let html = if f.def {
            let line_start = units[..f.from]
                .iter()
                .rposition(|&u| u == newline)
                .map_or(0, |p| p + 1);
            // A non-blank previous line would swallow the definition into its
            // paragraph as a soft break.
            let br = line_start > 0 && {
                let prev_start = units[..line_start - 1]
                    .iter()
                    .rposition(|&u| u == newline)
                    .map_or(0, |p| p + 1);
                !String::from_utf16_lossy(&units[prev_start..line_start - 1]).trim().is_empty()
            };
            let first = anchored.insert(f.label.to_lowercase());
            footnote_def_html(&f, first, br)
        } else {
            let source = source.map(|s| {
                let k = cited.entry(f.label.to_lowercase()).or_default();
                *k += 1;
                (s, *k)
            });
            footnote_ref_html(&f, source, link)
        };
        sentinels.push(&mut out, html);
        pos = f.to;
    }
    out.push_str(&String::from_utf16_lossy(&units[pos..]));
    (out, sentinels)
}

/// The Sources section for `list` (from `source_list`), or `""` when the
/// Concept has no `sources`. Each entry shows its number (blank when uncited),
/// its title (or resource) as a link to the resource when followable, the
/// resource below it, its credibility signals, the text of a body definition,
/// and a jump back to each citing claim.
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
        let note = s
            .note
            .as_deref()
            .map(|n| format!(r#"<span class="source-note">{}</span>"#, attr_escape(n)))
            .unwrap_or_default();
        let (signals, backrefs) = (signals_html(s), backrefs_html(s));
        out.push_str(&format!(
            r#"<li><span class="source-num">{num}</span><span class="source-body">{title}{resource}{signals}{note}{backrefs}</span></li>"#
        ));
    }
    out.push_str("</ol></section>");
    out
}

/// The entry's credibility signals as written (§5.1); `""` when it has none.
/// No score is computed.
fn signals_html(s: &Source) -> String {
    let mut items = Vec::new();
    let mut push = |key: &str, value: String| {
        items.push(format!(
            r#"<span class="source-signal"><span class="source-signal-key">{key}</span> {value}</span>"#
        ))
    };
    if let Some(a) = s.author.as_deref().filter(|a| !a.is_empty()) {
        push("Author", actor_html(a));
    }
    if let Some(m) = s.last_modified.as_deref().filter(|m| !m.is_empty()) {
        push("Last modified", attr_escape(m));
    }
    if let Some(c) = s.usage_count.as_deref().filter(|c| !c.is_empty()) {
        let window = s.usage_window.as_ref().map(window_text).unwrap_or_default();
        push("Usage count", attr_escape(&format!("{c}{window}")));
    }
    if items.is_empty() {
        return String::new();
    }
    format!(r#"<span class="source-signals">{}</span>"#, items.concat())
}

/// ` (from – to)` for a usage window; an open bound shows as `…`. The card's
/// `usageText` (`src/lib/sourceCard.ts`) writes the same.
fn window_text(w: &UsageWindow) -> String {
    let from = w.from.as_deref().unwrap_or("…");
    let to = w.to.as_deref().unwrap_or("…");
    format!(" ({from} – {to})")
}

/// An actor (§7) in the markup of `actorElement` (`src/lib/actor.ts`).
fn actor_html(raw: &str) -> String {
    let a = parse_actor(raw);
    let (kind, label) = match a.kind {
        ActorKind::Human => ("human", Some("person")),
        ActorKind::Process => ("process", Some("process")),
        ActorKind::Agent => ("agent", Some("agent")),
        ActorKind::Unknown => ("unknown", None),
    };
    let text = if label.is_some() { &a.id } else { &a.raw };
    let full = match &a.version {
        Some(v) => format!("{text} {v}"),
        None => text.clone(),
    };
    let title = match label {
        Some(l) => format!("{}{}: {full}", l[..1].to_uppercase(), &l[1..]),
        None => text.clone(),
    };
    let chip = label
        .map(|l| format!(r#"<span class="actor-kind">{l}</span>"#))
        .unwrap_or_default();
    let version = a
        .version
        .as_deref()
        .map(|v| format!(r#"<span class="actor-version">{}</span>"#, attr_escape(v)))
        .unwrap_or_default();
    format!(
        r#"<span class="actor actor-{kind}" title="{}">{chip}<span class="actor-id">{}</span>{version}</span>"#,
        attr_escape(&title),
        attr_escape(text),
    )
}

/// The jumps from an entry back to each claim citing it: `↑` alone for one
/// place, `↑ a b c` for several. `""` for an uncited entry.
fn backrefs_html(s: &Source) -> String {
    let Some(id) = s.id.as_deref() else {
        return String::new();
    };
    let n = s.refs.len();
    if n == 0 {
        return String::new();
    }
    let links: Vec<String> = (1..=n)
        .map(|k| {
            let text = if n == 1 { "↑".to_string() } else { backref_letter(k) };
            format!(
                r##"<a class="source-backref" href="#{}" title="Jump to citation {k}">{text}</a>"##,
                backref_id(id, k)
            )
        })
        .collect();
    let lead = if n == 1 { "" } else { "↑ " };
    format!(r#"<span class="source-backrefs">{lead}{}</span>"#, links.join(" "))
}

/// `a`…`z` for the first 26 citing places, then the number.
fn backref_letter(k: usize) -> String {
    match u8::try_from(k) {
        Ok(k @ 1..=26) => char::from(b'a' + k - 1).to_string(),
        _ => k.to_string(),
    }
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
        assert!(html.contains(r#"B<sup id="fnref-ssi-web-1" class="footnote-ref source" data-source="{&quot;id&quot;:&quot;ssi-web&quot;"#), "{html}");
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
        let web = r#"data-source="{&quot;id&quot;:&quot;web&quot;,&quot;resource&quot;:&quot;https://x.example/a?b=1&amp;c=2&quot;,&quot;kind&quot;:&quot;url&quot;,&quot;title&quot;:null,&quot;author&quot;:null,&quot;usageCount&quot;:null,&quot;lastModified&quot;:null,&quot;usageWindow&quot;:null,&quot;index&quot;:1,&quot;note&quot;:null,&quot;refs&quot;:[2,27],&quot;num&quot;:1}""#;
        assert!(
            html.contains(&format!(r#"A<sup id="fnref-web-1" class="footnote-ref source" {web}><a href="https://x.example/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">1</a></sup>"#)),
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
    fn a_footnote_in_embed_alt_text_neither_renders_nor_counts() {
        let html = render("![chart[^a]](x.png) text[^b]\n");
        assert!(html.contains(r#"text<sup class="footnote-ref broken" title="b">1</sup>"#), "{html}");
        assert!(!html.contains(r#"title="a""#), "{html}");
    }

    #[test]
    fn only_the_first_definition_of_a_label_owns_the_anchor() {
        let html = render("x[^a]\n\n[^a]: one\n\n[^A]: two\n");
        assert_eq!(html.matches(r#"id="fn-a""#).count(), 1, "{html}");
        assert!(html.contains(r#"<a id="fn-a" class="footnote-def" title="a">1</a> one"#), "{html}");
        assert!(html.contains(r#"<a class="footnote-def" title="A">1</a> two"#), "{html}");
    }

    #[test]
    fn a_definition_under_a_paragraph_line_breaks_onto_its_own_line() {
        let html = render("Text.\n[^1]: note\n");
        assert!(html.contains("Text.\n<br><a id=\"fn-1\""), "{html}");
        // A blank line before it starts a new paragraph: no break.
        let html = render("Text.\n\n[^1]: note\n");
        assert!(!html.contains("<br>"), "{html}");
        // The first line of the body has nothing to break from.
        assert!(!render("[^1]: note\n").contains("<br>"));
    }

    #[test]
    fn entries_jump_back_to_each_citing_claim() {
        let html = render_in(WITH_SOURCES, "notes/a.md", &["notes/a.md", "docs/spec.md"]);
        assert!(html.contains(r#"C<sup id="fnref-web-2" class="footnote-ref source""#), "{html}");
        let section = &html[html.find(r#"<section class="sources">"#).expect("section")..];
        // Two places: `↑ a b`; one place: a lone `↑`; uncited: nothing.
        assert!(section.contains(r##"<span class="source-backrefs">↑ <a class="source-backref" href="#fnref-web-1" title="Jump to citation 1">a</a> <a class="source-backref" href="#fnref-web-2" title="Jump to citation 2">b</a></span>"##), "{section}");
        assert!(section.contains(r##"<a class="source-backref" href="#fnref-spec-1" title="Jump to citation 1">↑</a>"##), "{section}");
        assert_eq!(section.matches("source-backrefs").count(), 3, "{section}");
    }

    #[test]
    fn signals_render_as_written_with_the_usage_window() {
        let body = "---\ntype: N\nsources:\n  - id: a\n    resource: https://a\n    author: human:dan\n    usage_count: 5000\n    last_modified: 2026-05-30T00:00:00Z\n  - id: b\n    resource: https://b\n    usage_count: 3\n    usage_window: { from: 2026-01-01 }\nusage_window: { from: 2026-06-01, to: 2026-06-30 }\n---\n\nx[^a]\n";
        let html = render(body);
        let section = &html[html.find(r#"<section class="sources">"#).expect("section")..];
        assert!(section.contains(r#"<span class="source-signal"><span class="source-signal-key">Author</span> <span class="actor actor-human" title="Person: dan"><span class="actor-kind">person</span><span class="actor-id">dan</span></span></span>"#), "{section}");
        assert!(section.contains(r#"<span class="source-signal-key">Last modified</span> 2026-05-30T00:00:00Z"#), "{section}");
        assert!(section.contains(r#"<span class="source-signal-key">Usage count</span> 5000 (2026-06-01 – 2026-06-30)"#), "{section}");
        // An entry's own window overrides the shared one; an open bound is `…`.
        assert!(section.contains(r#"<span class="source-signal-key">Usage count</span> 3 (2026-01-01 – …)"#), "{section}");
        assert!(!section.contains("score"), "{section}");
    }

    #[test]
    fn a_body_definition_for_a_source_moves_onto_its_entry() {
        let body = "---\ntype: N\nsources:\n  - id: s\n    resource: https://s\n---\n\nClaim[^s] and[^n].\n\n[^s]: Written <by> hand\n[^n]: a plain note\n";
        let html = render(body);
        let (text, section) = html.split_at(html.find(r#"<section class="sources">"#).expect("section"));
        assert!(!text.contains("hand</p>"), "{text}");
        assert!(!text.contains(r#"title="s""#), "{text}");
        // A definition with no `sources` entry keeps ov-14's behaviour.
        assert!(text.contains(r#"<a id="fn-n" class="footnote-def" title="n">2</a> a plain note"#), "{text}");
        assert!(section.contains(r#"<span class="source-note">Written &lt;by&gt; hand</span>"#), "{section}");
    }

    #[test]
    fn legacy_citations_list_still_renders_without_sources() {
        // A v0.1 Concept: `[n]` superscripts into a body `# Citations` list.
        let html = render("Revenue grew.[1] Margins held.[2]\n\n# Citations\n\n[1] Annual report\n[2] Q4 call\n");
        assert!(html.contains(r##"<sup class="citation-ref"><a href="#cite-1">[1]</a></sup>"##), "{html}");
        assert!(html.contains(r#"<a id="cite-2" class="citation-def">[2]</a> Q4 call"#), "{html}");
        assert!(html.contains("Citations</h1>"), "{html}");
        assert!(!html.contains(r#"class="sources""#), "{html}");
    }

    #[test]
    fn backref_letters() {
        assert_eq!(super::backref_letter(1), "a");
        assert_eq!(super::backref_letter(26), "z");
        assert_eq!(super::backref_letter(27), "27");
    }

    #[test]
    fn no_sources_no_section() {
        assert!(!render("x[^1]\n\n[^1]: one\n").contains("sources"));
    }
}
