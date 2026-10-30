use super::*;
use Severity::{Error, Info, Warning};

/// Findings as `(severity, marked text, source)`, for compact assertions. The
/// fixtures are ASCII, so UTF-16 offsets are byte offsets.
fn marks(yaml: &str, mode: LintMode) -> Vec<(Severity, String, String)> {
    lint_frontmatter(yaml, mode)
        .into_iter()
        .map(|f| (f.severity, yaml[f.from..f.to].to_string(), f.source))
        .collect()
}

/// OKF-mode findings from one family, as `(severity, marked text)`.
fn family(yaml: &str, source: &str) -> Vec<(Severity, String)> {
    marks(yaml, LintMode::Okf).into_iter().filter(|m| m.2 == source).map(|(s, t, _)| (s, t)).collect()
}

fn m(s: Severity, t: &str) -> (Severity, String) {
    (s, t.to_string())
}

fn ms(s: Severity, t: &str, src: &str) -> (Severity, String, String) {
    (s, t.to_string(), src.to_string())
}

fn lines(ls: &[&str]) -> String {
    ls.join("\n") + "\n"
}

use LintMode::{Okf, Yaml};

// ── well-formedness (every Bundle) ──────────────────────────────────────────

#[test]
fn well_formed_block_is_clean_in_yaml_mode() {
    assert!(lint_frontmatter("title: x\ntags: [a]\n", Yaml).is_empty());
    assert!(lint_frontmatter("", Yaml).is_empty());
    assert!(lint_frontmatter("sources:\n  - id: x\n", Yaml).is_empty());
}

#[test]
fn malformed_yaml_is_a_positioned_error_in_both_modes() {
    for mode in [Yaml, Okf] {
        let yaml = "type: a\ntags: [a, b\n";
        let findings = lint_frontmatter(yaml, mode);
        assert!(!findings.is_empty());
        for f in findings {
            assert_eq!((f.severity, f.source.as_str()), (Error, "yaml"));
            assert!(f.to <= yaml.len());
            assert!(!f.message.contains('\n'));
        }
    }
    assert!(lint_frontmatter("title: [x\n", Okf).iter().all(|f| f.source == "yaml"));
}

#[test]
fn duplicate_keys_are_reported_at_the_key() {
    let yaml = "type: a\ntitle: x\ntype: b\ngenerated:\n  by: x\n  by: y\n";
    for mode in [Yaml, Okf] {
        assert_eq!(marks(yaml, mode), vec![ms(Error, "type", "yaml"), ms(Error, "by", "yaml")]);
    }
    assert_eq!(lint_frontmatter(yaml, Yaml)[0].message, "Duplicate key `type`");
    assert_eq!(lint_frontmatter(yaml, Yaml)[1].line, 6);
}

// ── core (§4.1) ─────────────────────────────────────────────────────────────

#[test]
fn core_type() {
    assert!(lint_frontmatter("type: Metric\n", Okf).is_empty());
    assert_eq!(marks("title: Revenue\ndescription: d\n", Okf), vec![ms(Error, "title: Revenue", "okf")]);
    assert!(lint_frontmatter("title: Revenue\n", Okf)[0].message.contains("`type`"));
    let empty = lint_frontmatter("", Okf);
    assert_eq!((empty[0].from, empty[0].to, empty[0].severity), (0, 0, Error));
    assert_eq!(marks("type:\ntitle: x\n", Okf), vec![ms(Error, "type:", "okf")]);
    assert_eq!(marks("type: ''\n", Okf), vec![ms(Error, "type: ''", "okf")]);
    assert_eq!(marks("- a\n- b\n", Okf), vec![ms(Error, "- a\n- b\n", "okf")]);
}

#[test]
fn core_recommended_keys_are_warnings() {
    let yaml = "type: x\ntitle: 1984\ndescription: [a]\ntags: solo\n";
    assert_eq!(
        marks(yaml, Okf),
        vec![
            ms(Warning, "title: 1984", "okf"),
            ms(Warning, "description: [a]", "okf"),
            ms(Warning, "tags: solo", "okf"),
        ]
    );
    assert!(lint_frontmatter("type: x\ntags: [a, b]\n", Okf).is_empty());
    assert!(lint_frontmatter("type: x\ntags:\n  - a\n  - b\n", Okf).is_empty());
    assert!(lint_frontmatter("type: x\nowner: team-a\nnested: { a: 1 }\n", Okf).is_empty());
}

#[test]
fn a_legacy_timestamp_is_info() {
    assert_eq!(marks("type: x\ntimestamp: 2026-06-15\n", Okf), vec![ms(Info, "timestamp", "okf")]);
    assert!(lint_frontmatter("timestamp: 2026-06-15\n", Yaml).is_empty());
}

// ── REQUIRED family fields ──────────────────────────────────────────────────

#[test]
fn required_family_fields_are_errors() {
    let yaml = "type: x\nsources:\n  - id: ga4\n    title: GA4\n  - resource: https://x\n";
    assert_eq!(marks(yaml, Okf), vec![ms(Error, "id: ga4", "okf-provenance")]);
    assert!(lint_frontmatter(yaml, Okf)[0].message.contains("`sources[]`"));
    assert_eq!(marks("type: x\nsources: [{ id: a }]\n", Okf), vec![ms(Error, "{ id: a }", "okf-provenance")]);
    for yaml in [
        "type: x\ngenerated:\n  at: 2026-01-01T00:00:00Z\n",
        "type: x\ngenerated: { at: 2026-01-01T00:00:00Z }\n",
        "type: x\ngenerated:\n",
    ] {
        assert_eq!(marks(yaml, Okf), vec![ms(Error, "generated", "okf-trust")], "{yaml}");
    }
    assert_eq!(
        marks("type: x\ngenerated: { by: \"\", at: 2026-01-01T00:00:00Z }\n", Okf),
        vec![ms(Error, "by: \"\"", "okf-trust")]
    );
}

#[test]
fn complete_families_are_clean_and_yaml_mode_is_silent() {
    let yaml = lines(&[
        "type: Metric",
        "sources:",
        "  - id: a",
        "    resource: https://example.com",
        "generated: { by: agent:x, at: 2026-06-20T22:53:05Z }",
        "verified:",
        "  - { by: human:a, at: 2026-06-25T09:00:00Z }",
        "status: stable",
    ]);
    assert!(lint_frontmatter(&yaml, Okf).is_empty());
    assert!(lint_frontmatter("sources:\n  - id: a\ngenerated: { at: x }\n", Yaml).is_empty());
}

#[test]
fn families_are_scoped_and_findings_sorted() {
    assert!(!lint_frontmatter("title: no type here\n", Okf).iter().any(|f| f.source == "okf-provenance"));
    let yaml = "generated: { at: 2026-01-01T00:00:00Z }\nsources:\n  - id: a\ntitle: 5\n";
    let froms: Vec<usize> = lint_frontmatter(yaml, Okf).iter().map(|f| f.from).collect();
    let mut sorted = froms.clone();
    sorted.sort();
    assert_eq!(froms, sorted);
    assert_eq!(froms.len(), 4); // type missing, generated.by, sources[].resource, title
}

#[test]
fn offsets_are_utf16_and_lines_one_based() {
    let yaml = "type: x\ntitle: \"🦀\"\nstatus: wip\n";
    let f = &lint_frontmatter(yaml, Okf)[0];
    let utf16: Vec<u16> = yaml.encode_utf16().collect();
    assert_eq!(String::from_utf16(&utf16[f.from..f.to]).unwrap(), "wip");
    assert_eq!(f.line, 3);
}

// ── trust (§5.2) ────────────────────────────────────────────────────────────

#[test]
fn trust_lint() {
    let t = |y: &str| family(y, "okf-trust");
    assert_eq!(t("type: x\ngenerated:\n  at: 2026-06-20\n"), vec![m(Error, "generated"), m(Warning, "at: 2026-06-20")]);
    assert_eq!(
        t("type: x\ngenerated: { by: a/1, at: 2026-06-20T10:00:00 }\n"),
        vec![m(Warning, "at: 2026-06-20T10:00:00")]
    );
    assert_eq!(t("type: x\ngenerated: { by: a/1, at: 2026 }\n"), vec![m(Warning, "at: 2026")]);
    assert_eq!(
        t("type: x\nverified:\n  - { by: human:a, at: 2026-06-25T09:00:00Z }\n  - { by: process:p, at: monday }\n"),
        vec![m(Warning, "at: monday")]
    );
    assert_eq!(t("type: x\nverified: { by: human:a, at: monday }\n"), vec![m(Warning, "at: monday")]);
    assert!(t("type: x\nverified: { by: human:a, at: 2026-06-25T09:00:00Z }\n").is_empty());
    assert!(t("type: x\nverified:\n  by: human:a\n  at: 2026-06-25T09:00:00+02:00\n").is_empty());
    assert_eq!(
        t("type: x\nverified:\n  - { at: 2026-06-25T09:00:00Z }\n  - by: human:a\n"),
        vec![m(Warning, "{ at: 2026-06-25T09:00:00Z }"), m(Warning, "by: human:a")]
    );
    assert_eq!(t("type: x\ngenerated: agent/1\n"), vec![m(Warning, "generated: agent/1")]);
    assert_eq!(t("type: x\nverified: human:a\n"), vec![m(Warning, "verified: human:a")]);
    assert_eq!(t("type: x\nverified:\n  - human:a\n"), vec![m(Warning, "human:a")]);
    assert!(t("type: x\ntimestamp: 2026-06-15\n").is_empty());
    assert!(lint_frontmatter("generated:\n  at: whenever\nverified: nope\n", Yaml).is_empty());
}

// ── provenance (§5.1) ───────────────────────────────────────────────────────

#[test]
fn provenance_spec_example_is_clean() {
    let yaml = lines(&[
        "type: Metric",
        "sources:",
        "  - id: ga4-schema",
        "    resource: https://developers.google.com/analytics/bigquery/export-schema",
        "    title: GA4 BigQuery Export schema",
        "    author: team:ga4-docs",
        "    usage_count: 5000",
        "    last_modified: 2026-05-30T00:00:00Z",
        "  - resource: all queries in BigQuery project X",
        "  - resource: references/skills/run.md",
        "usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }",
    ]);
    assert!(lint_frontmatter(&yaml, Okf).is_empty());
}

#[test]
fn provenance_lint() {
    let p = |y: &str| family(y, "okf-provenance");
    assert_eq!(p("sources: https://x\n"), vec![m(Warning, "sources: https://x")]);
    assert_eq!(p(&lines(&["sources:", "  - https://x", "  - resource: /a.md"])), vec![m(Warning, "https://x")]);
    assert_eq!(p(&lines(&["sources:", "  - id: a"])), vec![m(Error, "id: a")]);
    assert!(p("sources:\n").is_empty());
    assert!(p("sources: []\n").is_empty());
    assert_eq!(
        p(&lines(&["sources:", "  - resource: [a, b]", "    title: { x: 1 }"])),
        vec![m(Warning, "resource: [a, b]"), m(Warning, "title: { x: 1 }")]
    );
    assert_eq!(
        p(&lines(&["sources:", "  - { id: a, resource: /a.md }", "  - { id: A, resource: /b.md }"])),
        vec![m(Warning, "A")]
    );
    assert_eq!(
        p(&lines(&[
            "sources:",
            "  - { resource: x, usage_count: lots }",
            "  - { resource: y, usage_count: -1 }",
            "  - { resource: z, usage_count: 2.5 }",
            "  - { resource: w, usage_count: 0 }",
            "usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }",
        ])),
        vec![m(Warning, "usage_count: lots"), m(Warning, "usage_count: -1"), m(Warning, "usage_count: 2.5")]
    );
}

#[test]
fn provenance_windows_and_dates() {
    let p = |y: &str| family(y, "okf-provenance");
    assert_eq!(p(&lines(&["sources: []", "usage_window: last month"])), vec![m(Warning, "last month")]);
    assert_eq!(p("usage_window: { from: 2026-06-01, to: 2026-06-30T00:00:00Z }\n"), vec![m(Warning, "2026-06-01")]);
    assert_eq!(
        p("usage_window: { from: 2026-07-01T00:00:00Z, to: 2026-06-30T00:00:00+02:00 }\n"),
        vec![m(Warning, "{ from: 2026-07-01T00:00:00Z, to: 2026-06-30T00:00:00+02:00 }")]
    );
    assert_eq!(
        p(&lines(&["sources:", "  - resource: x", "    usage_window: { to: yesterday }"])),
        vec![m(Warning, "yesterday")]
    );
    assert_eq!(
        p(&lines(&["sources:", "  - { resource: x, last_modified: May 2026 }"])),
        vec![m(Warning, "May 2026")]
    );
    let bare = lines(&["sources:", "  - resource: x", "    usage_count: 5"]);
    assert_eq!(p(&bare), vec![m(Info, "usage_count")]);
    let own = bare.clone() + "    usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }\n";
    assert!(p(&own).is_empty());
    let shared = bare + "usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }\n";
    assert!(p(&shared).is_empty());
    assert!(p("type: x\n").is_empty());
}

// ── lifecycle (§5.4, §5.5) ──────────────────────────────────────────────────

#[test]
fn lifecycle_status() {
    let l = |y: &str| family(y, "okf-lifecycle");
    for s in ["draft", "stable", "deprecated"] {
        assert!(l(&format!("type: x\nstatus: {s}\n")).is_empty());
    }
    for (v, marked) in [("wip", "wip"), ("Draft", "Draft"), ("3", "3"), ("[draft]", "[draft]")] {
        assert_eq!(l(&format!("type: x\nstatus: {v}\n")), vec![m(Error, marked)]);
    }
    assert_eq!(l("type: x\nstatus:\n"), vec![m(Error, "status:")]);
    assert!(lint_frontmatter("status: wip\nstale_after: soon\n", Yaml).is_empty());
}

#[test]
fn lifecycle_stale_after() {
    let l = |y: &str| family(y, "okf-lifecycle");
    assert!(l("type: x\nstale_after: 2026-09-23T00:00:00Z\n").is_empty());
    assert!(l("type: x\nstale_after: \"2026-09-23T02:00:00+02:00\"\n").is_empty());
    assert_eq!(l("type: x\nstale_after: 2026-09-23T00:00:00\n"), vec![m(Warning, "2026-09-23T00:00:00")]);
    assert_eq!(l("type: x\nstale_after: 2026-09-23\n"), vec![m(Warning, "2026-09-23")]);
    let msg = |y: &str| lint_frontmatter(y, Okf).into_iter().find(|f| f.source == "okf-lifecycle").unwrap().message;
    assert!(msg("stale_after: 2026-09-23\n").contains("offset"));
    assert!(!msg("stale_after: next week\n").contains("offset"));
    assert_eq!(l("type: x\nstale_after: next week\n"), vec![m(Warning, "next week")]);
    assert_eq!(l("type: x\nstale_after: 2026\n"), vec![m(Warning, "2026")]);
    assert_eq!(l("type: x\nstale_after:\n"), vec![m(Warning, "stale_after:")]);
    // Staleness is advisory, never a lint finding.
    assert!(l("type: x\nstale_after: 2000-01-01T00:00:00Z\n").is_empty());
}

// ── computation (§10.2) ─────────────────────────────────────────────────────

const AC: &str = "type: Attested Computation";

fn comp(ls: &[&str]) -> Vec<(Severity, String)> {
    family(&lines(ls), "okf-computation")
}

#[test]
fn computation_spec_example_is_clean() {
    let yaml = lines(&[
        AC,
        "title: Revenue for fiscal year",
        "runtime: bigquery",
        "parameters:",
        "  - { name: year, type: integer, required: true }",
        "executor:",
        "  resource: references/skills/run-on-bq.md",
        "  receipt: [job_id, executed_sql, result]",
        "attester:",
        "  resource: references/attesters/revenue.py",
    ]);
    assert!(lint_frontmatter(&yaml, Okf).is_empty());
}

#[test]
fn computation_runtime_and_scope() {
    assert_eq!(comp(&[AC]), vec![m(Error, "type")]);
    assert_eq!(comp(&[AC, "runtime:"]), vec![m(Error, "runtime:")]);
    assert_eq!(comp(&[AC, "runtime: [a]"]), vec![m(Warning, "runtime: [a]")]);
    assert!(comp(&[AC, "runtime: python"]).is_empty());
    assert!(comp(&[AC, "runtime: python", "parameters:", "executor:", "attester:", "computation:"]).is_empty());
    assert!(comp(&[AC, "runtime: python", "parameters: []", "executor: {}", "attester: {}"]).is_empty());
    assert!(comp(&["type: Metric", "runtime: [a]", "parameters: 3", "executor: x"]).is_empty());
    assert!(comp(&["title: no type", "parameters: 3"]).is_empty());
}

#[test]
fn computation_parameters() {
    assert_eq!(comp(&[AC, "runtime: python", "parameters: year"]), vec![m(Warning, "parameters: year")]);
    assert_eq!(
        comp(&[
            AC,
            "runtime: python",
            "parameters:",
            "  - name: year",
            "    type: integer",
            "  - year",
            "  - { name: a }",
            "  - { type: date }",
            "  - { name: [x], type: date, required: yes please }",
            "  - { name: year, type: integer, required: false }",
        ]),
        vec![
            m(Warning, "year"),
            m(Warning, "{ name: a }"),
            m(Warning, "{ type: date }"),
            m(Warning, "name: [x]"),
            m(Warning, "required: yes please"),
            m(Warning, "year"),
        ]
    );
}

#[test]
fn computation_paths_and_endpoints() {
    assert_eq!(
        comp(&[
            AC,
            "runtime: python",
            "computation: [a.sql]",
            "executor: { resource: { x: 1 } }",
            "attester: { resource: references/attest.py }",
        ]),
        vec![m(Warning, "computation: [a.sql]"), m(Warning, "resource: { x: 1 }")]
    );
    assert_eq!(
        comp(&[AC, "runtime: python", "executor: run.md", "attester: a.py"]),
        vec![m(Warning, "executor: run.md"), m(Warning, "attester: a.py")]
    );
    assert_eq!(comp(&[AC, "runtime: python", "executor:", "  receipt: job_id"]), vec![m(Warning, "receipt: job_id")]);
    assert_eq!(
        comp(&[AC, "runtime: python", "executor:", "  receipt: [job_id, { a: 1 }]"]),
        vec![m(Warning, "receipt: [job_id, { a: 1 }]")]
    );
    assert!(comp(&[AC, "runtime: python", "executor:", "  receipt:", "    - job_id", "    - result"]).is_empty());
}
