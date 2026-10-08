//! The contract card of an Attested Computation (OKF v0.2 §10, ov-12): its
//! `runtime`, `parameters`, `computation`, `executor` (with `receipt`) and
//! `attester`, shown above the body after the trust line. Rendered only; it is
//! never in the file, and nothing is executed or verified.
//!
//! The reading of the keys is `sunstone_shared::computation`; this module only
//! builds the markup, which is the same markup as the editor's and the fake's
//! (`src/lib/computation.ts`, which asserts the same goldens). A path-valued
//! field's `<a>` gets the attributes of a markdown link to the same value
//! (`link`, i.e. `link_attrs`): the same resolution as any in-Bundle link.

use sunstone_shared::computation::{computation_section, contract, Contract, Parameter, PathField};
use sunstone_shared::outline::OutlineHeading;

use super::attr_escape;

const HEADING_HINT: &str =
    "OKF §10: the sanctioned way to compute this value. Shown only: Sunstone does not run or verify it.";

/// The contract card for a Frontmatter block (inner YAML), or `""` without one.
pub(super) fn contract_card_html(yaml: &str, link: &dyn Fn(&str) -> String) -> String {
    contract(yaml).map(|c| contract_html(&c, link)).unwrap_or_default()
}

/// Wrap an Attested Computation's `# Computation` section of the rendered
/// `html` body (ov-13) in `<section class="computation-section">`, from its
/// heading to the next heading of the same or a higher level (or the end).
/// `outline` is the document's outline, whose slugs are the heading ids;
/// unchanged on any other type or without the heading.
pub(super) fn wrap_computation_section(html: &str, yaml: &str, body: &str, outline: &[OutlineHeading]) -> String {
    let Some(sec) = computation_section(yaml, body) else {
        return html.to_string();
    };
    let tag = |h: &OutlineHeading| format!(r#"<h{} id="{}">"#, h.level, attr_escape(&h.slug));
    let Some(at) = outline.iter().position(|h| h.slug == sec.slug) else {
        return html.to_string();
    };
    let Some(start) = html.find(&tag(&outline[at])) else {
        return html.to_string();
    };
    let end = outline[at + 1..]
        .iter()
        .find(|h| h.level <= sec.level)
        .and_then(|h| html[start..].find(&tag(h)).map(|i| start + i))
        .unwrap_or(html.len());
    format!(
        r#"{}<section class="computation-section" data-testid="computation-section">{}</section>{}"#,
        &html[..start],
        &html[start..end],
        &html[end..]
    )
}

fn contract_html(c: &Contract, link: &dyn Fn(&str) -> String) -> String {
    let mut rows: Vec<String> = Vec::new();
    let mut row = |label: &str, value: String| rows.push(format!("<dt>{label}</dt><dd>{value}</dd>"));
    if let Some(r) = &c.runtime {
        row("Runtime", format!(r#"<code class="computation-runtime">{}</code>"#, attr_escape(r)));
    }
    if !c.parameters.is_empty() {
        let items: String = c.parameters.iter().map(param_html).collect();
        row("Parameters", format!(r#"<ul class="computation-params">{items}</ul>"#));
    }
    if let Some(f) = &c.computation {
        row("Computation", path_html(f, link));
    }
    if let Some(e) = &c.executor {
        let mut parts: Vec<String> = Vec::new();
        if let Some(f) = &e.resource {
            parts.push(path_html(f, link));
        }
        if !e.receipt.is_empty() {
            let names: Vec<String> = e.receipt.iter().map(|n| format!("<code>{}</code>", attr_escape(n))).collect();
            parts.push(format!(
                r#"<span class="computation-receipt"><span class="computation-label">Receipt</span> {}</span>"#,
                names.join(" ")
            ));
        }
        if !parts.is_empty() {
            row("Executor", parts.join(" "));
        }
    }
    if let Some(f) = c.attester.as_ref().and_then(|a| a.resource.as_ref()) {
        row("Attester", path_html(f, link));
    }
    if rows.is_empty() {
        return String::new();
    }
    format!(
        r#"<section class="computation" data-testid="computation"><div class="computation-heading" title="{}">Attested Computation</div><dl class="computation-fields">{}</dl></section>"#,
        attr_escape(HEADING_HINT),
        rows.concat()
    )
}

fn param_html(p: &Parameter) -> String {
    let name = match &p.name {
        Some(n) => format!(r#"<code class="computation-param-name">{}</code>"#, attr_escape(n)),
        None => r#"<span class="computation-missing">unnamed</span>"#.to_string(),
    };
    let kind = p
        .kind
        .as_deref()
        .map(|t| format!(r#" <span class="computation-param-type">{}</span>"#, attr_escape(t)))
        .unwrap_or_default();
    let req = match p.required {
        Some(true) => r#" <span class="computation-param-required">required</span>"#,
        Some(false) => r#" <span class="computation-param-optional">optional</span>"#,
        None => "",
    };
    format!("<li>{name}{kind}{req}</li>")
}

fn path_html(f: &PathField, link: &dyn Fn(&str) -> String) -> String {
    let v = attr_escape(&f.value);
    format!(r#"<a data-resource="{v}" {}>{v}</a>"#, link(&f.value))
}

#[cfg(test)]
mod tests {
    use super::*;

    const REVENUE: &str = "type: Attested Computation
title: Revenue for fiscal year
runtime: bigquery
parameters:
  - { name: year, type: integer, required: true }
executor:
  resource: references/skills/run-on-bq.md
  receipt: [job_id, executed_sql, result]
attester:
  resource: references/attesters/revenue.py
";

    fn raw_href(v: &str) -> String {
        format!(r#"href="{}""#, attr_escape(v))
    }

    // The same golden as `src/lib/computation.test.ts` (with the fake's raw href).
    const GOLDEN: &str = concat!(
        r#"<section class="computation" data-testid="computation">"#,
        r#"<div class="computation-heading" title="OKF §10: the sanctioned way to compute this value. Shown only: Sunstone does not run or verify it.">Attested Computation</div>"#,
        r#"<dl class="computation-fields">"#,
        r#"<dt>Runtime</dt><dd><code class="computation-runtime">bigquery</code></dd>"#,
        r#"<dt>Parameters</dt><dd><ul class="computation-params"><li><code class="computation-param-name">year</code> <span class="computation-param-type">integer</span> <span class="computation-param-required">required</span></li></ul></dd>"#,
        r#"<dt>Executor</dt><dd><a data-resource="references/skills/run-on-bq.md" href="references/skills/run-on-bq.md">references/skills/run-on-bq.md</a> <span class="computation-receipt"><span class="computation-label">Receipt</span> <code>job_id</code> <code>executed_sql</code> <code>result</code></span></dd>"#,
        r#"<dt>Attester</dt><dd><a data-resource="references/attesters/revenue.py" href="references/attesters/revenue.py">references/attesters/revenue.py</a></dd>"#,
        r#"</dl></section>"#,
    );

    #[test]
    fn spec_example_matches_the_editor() {
        assert_eq!(contract_card_html(REVENUE, &raw_href), GOLDEN);
    }

    #[test]
    fn parameters_match_the_editor() {
        let html = contract_card_html(
            "type: Attested Computation\nparameters:\n  - { name: a, type: string }\n  - { name: b, type: date, required: false }\n  - { type: integer }\n",
            &raw_href,
        );
        assert!(html.contains(concat!(
            r#"<ul class="computation-params"><li><code class="computation-param-name">a</code> <span class="computation-param-type">string</span></li>"#,
            r#"<li><code class="computation-param-name">b</code> <span class="computation-param-type">date</span> <span class="computation-param-optional">optional</span></li>"#,
            r#"<li><span class="computation-missing">unnamed</span> <span class="computation-param-type">integer</span></li></ul>"#,
        )));
    }

    #[test]
    fn nothing_to_show_is_no_card() {
        assert_eq!(contract_card_html("type: Attested Computation\n", &raw_href), "");
        assert_eq!(contract_card_html("type: Metric\nruntime: bigquery\n", &raw_href), "");
        let html = contract_card_html("type: Attested Computation\nruntime: python\n", &raw_href);
        assert!(html.contains("<dt>Runtime</dt>") && !html.contains("<dt>Executor</dt>"));
    }
}
