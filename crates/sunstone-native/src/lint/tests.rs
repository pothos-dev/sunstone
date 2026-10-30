use super::*;

const OKF_ROOT: (&str, &str) = ("index.md", "---\nokf_version: \"0.2\"\n---\n# Home\n\n* [A](a.md)\n");

/// A Bundle of `files`, with `extra` as the non-`.md` files on disk.
fn snapshot(files: &[(&str, &str)], extra: &[&'static str]) -> Snapshot {
    let extra: Vec<&'static str> = extra.to_vec();
    Snapshot {
        concepts: files.iter().map(|(p, c)| (p.to_string(), c.to_string())).collect(),
        attachments: extra.iter().filter(|p| embed::is_image_path(p)).map(|p| p.to_string()).collect(),
        exists: Box::new(move |p: &str| extra.contains(&p)),
        git_prefix: None,
        now: 1_800_000_000, // 2027-01-15
        exclude: Exclude::default(),
    }
}

/// Diagnostics as `(path, line, code)`.
fn found(files: &[(&str, &str)], extra: &[&'static str]) -> Vec<(String, usize, String)> {
    lint_snapshot(&snapshot(files, extra)).diagnostics.into_iter().map(|d| (d.path, d.line, d.code)).collect()
}

fn d(path: &str, line: usize, code: &str) -> (String, usize, String) {
    (path.to_string(), line, code.to_string())
}

#[test]
fn a_healthy_okf_bundle_is_clean() {
    let a = "---\ntype: Guide\n---\n# Intro\n\nSee [b](sub/b.md#setup) and [[b]] and [top](#intro).\n";
    let sub_index = "# Sub\n\n* [B](b.md)\n";
    let b = "---\ntype: Guide\n---\n## Setup\n\n![logo](../logo.png)\n";
    let report = lint_snapshot(&snapshot(
        &[OKF_ROOT, ("a.md", a), ("sub/index.md", sub_index), ("sub/b.md", b)],
        &["logo.png"],
    ));
    assert_eq!(report.diagnostics, vec![]);
    assert_eq!(report.okf_version.as_deref(), Some("0.2"));
    assert_eq!(report.files, 4);
}

#[test]
fn broken_links_wikilinks_anchors_and_embeds_are_errors_with_lines() {
    let a = "---\ntype: x\n---\n# Intro\n\n[gone](gone.md)\n[[nowhere]]\n[bad](#outro)\n[far](b.md#nope)\n![img](pic.png)\n![[missing.png]]\n[file](script.py) [dir](assets/)\n";
    let b = "---\ntype: x\n---\n# B\n";
    assert_eq!(
        found(&[OKF_ROOT, ("a.md", a), ("b.md", b)], &["script.py", "assets"]),
        vec![
            d("a.md", 6, "broken-link"),
            d("a.md", 7, "broken-wikilink"),
            d("a.md", 8, "broken-anchor"),
            d("a.md", 9, "broken-anchor"),
            d("a.md", 10, "broken-embed"),
            d("a.md", 11, "broken-embed"),
            d("index.md", 1, "index-unlisted"),
        ]
    );
}

#[test]
fn a_repeated_link_is_reported_on_each_line() {
    let a = "---\ntype: x\n---\n[x](gone.md)\n\n[x](gone.md)\n";
    assert_eq!(found(&[OKF_ROOT, ("a.md", a)], &[]), vec![d("a.md", 4, "broken-link"), d("a.md", 6, "broken-link")]);
}

#[test]
fn frontmatter_findings_come_from_the_shared_lint_on_file_lines() {
    let a = "---\ntitle: no type\nstatus: wip\n---\nbody\n";
    let report = lint_snapshot(&snapshot(&[OKF_ROOT, ("a.md", a)], &[]));
    let lines: Vec<(usize, Severity)> = report.diagnostics.iter().map(|d| (d.line, d.severity)).collect();
    assert_eq!(lines, vec![(2, Severity::Error), (3, Severity::Error)]);
    assert!(report.diagnostics[0].message.contains("`type`"));
}

#[test]
fn okf_conformance_missing_frontmatter_and_reserved_files() {
    let log = "---\ntitle: x\n---\n# Log\n";
    let sub_index = "---\ntype: x\n---\n* [b](b.md)\n";
    assert_eq!(
        found(
            &[
                OKF_ROOT,
                ("a.md", "# no frontmatter\n"),
                ("log.md", log),
                ("sub/index.md", sub_index),
                ("sub/b.md", "---\ntype: x\n---\n"),
            ],
            &[]
        ),
        vec![d("a.md", 1, "frontmatter-missing"), d("log.md", 1, "reserved-frontmatter"), d("sub/index.md", 1, "reserved-frontmatter")]
    );
}

#[test]
fn without_okf_version_only_yaml_links_and_footnotes_are_checked() {
    let a = "---\ntitle: [unclosed\n---\n[x](gone.md) and a note[^n]\n";
    let report = lint_snapshot(&snapshot(&[("index.md", "# Notes\n"), ("a.md", a), ("b.md", "no frontmatter\n")], &[]));
    assert_eq!(report.okf_version, None);
    let codes: Vec<&str> = report.diagnostics.iter().map(|d| d.code.as_str()).collect();
    assert_eq!(codes, vec!["yaml", "broken-link", "footnote-undefined"]);
}

#[test]
fn footnotes_resolve_against_definitions_and_source_ids() {
    let a = "---\ntype: x\nsources:\n  - { id: ga4, resource: https://x }\n---\nCited[^ga4], defined[^d], dangling[^z] and again[^z].\n\n[^d]: A note.\n";
    assert_eq!(found(&[OKF_ROOT, ("a.md", a)], &[]), vec![d("a.md", 6, "footnote-undefined")]);
}

#[test]
fn path_valued_fields_must_exist() {
    // A top-level `resource` is the described asset's URI, not a Bundle path: unchecked.
    let a = "---\ntype: x\nresource: /data/table.csv\nsources:\n  - resource: ./gone.md\n  - resource: all queries in project X\n  - resource: https://example.com\n---\n";
    assert_eq!(found(&[OKF_ROOT, ("a.md", a)], &[]), vec![d("a.md", 4, "missing-resource")]);
    let with_target = found(&[OKF_ROOT, ("a.md", a), ("gone.md", "---\ntype: x\n---\n")], &[]);
    assert!(!with_target.iter().any(|f| f.2 == "missing-resource"));
}

#[test]
fn a_resource_may_live_in_the_repository_around_the_bundle() {
    let a = "---\ntype: x\nsources:\n  - resource: src/main.rs\n---\n";
    let mut s = snapshot(&[OKF_ROOT, ("a.md", a)], &["../src/main.rs"]);
    assert_eq!(lint_snapshot(&s).diagnostics.len(), 1);
    s.git_prefix = Some("docs/".into());
    assert_eq!(lint_snapshot(&s).diagnostics, vec![]);
}

#[test]
fn links_in_code_are_examples_and_links_out_of_the_folder_are_checked_on_disk() {
    let a = "---\ntype: x\n---\nWrite `[x](./path.md)` to link.\n\n```\n[y](gone.md)\n```\n[up](../../docker/README.md#env) [lost](../nope.md)\n";
    assert_eq!(
        found(&[OKF_ROOT, ("sub/a.md", a), ("sub/index.md", "* [a](a.md)\n")], &["../docker/README.md"]),
        vec![d("index.md", 6, "broken-link"), d("sub/a.md", 9, "broken-link")]
    );
}

#[test]
fn a_past_stale_after_is_info() {
    let a = "---\ntype: x\nstale_after: 2026-01-01T00:00:00Z\n---\n";
    let report = lint_snapshot(&snapshot(&[OKF_ROOT, ("a.md", a)], &[]));
    assert_eq!(report.diagnostics.len(), 1);
    assert_eq!((report.diagnostics[0].line, report.diagnostics[0].severity), (3, Severity::Info));
    let fresh = "---\ntype: x\nstale_after: 2030-01-01T00:00:00Z\n---\n";
    assert!(lint_snapshot(&snapshot(&[OKF_ROOT, ("a.md", fresh)], &[])).diagnostics.is_empty());
}

#[test]
fn a_legacy_citations_list_is_info() {
    let a = "---\ntype: x\n---\n# A\n\n## Citations\n\n[1] x\n";
    assert_eq!(found(&[OKF_ROOT, ("a.md", a)], &[]), vec![d("a.md", 6, "legacy-citations")]);
    // A section about citations, with examples only in code, is not a list.
    let about = "---\ntype: x\n---\n## Citations\n\nWrite `[1]` rows:\n\n```\n[1] x\n```\n## Next\n\n[1] not in the section\n";
    assert_eq!(found(&[OKF_ROOT, ("a.md", about)], &[]), vec![]);
}

#[test]
fn okf_checks_stop_at_the_bundle_root() {
    // The root is `docs/` (its index declares the version); `notes/` is outside.
    let root_index = "---\nokf_version: \"0.2\"\n---\n* [a](a.md)\n";
    let report = lint_snapshot(&snapshot(
        &[("docs/index.md", root_index), ("docs/a.md", "---\ntype: x\n---\n"), ("notes/n.md", "no frontmatter\n")],
        &[],
    ));
    assert_eq!(report.bundle_root, "docs");
    assert_eq!(report.diagnostics, vec![]);
}

#[test]
fn text_report_is_compiler_style_with_a_summary() {
    let report = lint_snapshot(&snapshot(&[OKF_ROOT, ("a.md", "---\ntype: x\n---\n[x](gone.md)\n")], &[]));
    let text = render_text(&report, "docs", false);
    assert!(text.starts_with("docs/a.md:4: error: Link target does not exist: `gone.md` [broken-link]\n"), "{text}");
    assert!(text.ends_with("1 error in 2 files\n"), "{text}");
    let clean = lint_snapshot(&snapshot(&[OKF_ROOT, ("a.md", "---\ntype: x\n---\n")], &[]));
    assert_eq!(render_text(&clean, ".", false), "✓ 2 files checked, no problems\n");
    assert!(render_json(&report).contains("\"code\": \"broken-link\""));
}

#[test]
fn excluded_files_are_not_checked_but_stay_link_targets() {
    let a = "---\ntype: x\n---\n[t](tickets/t1.md) [gone](gone.md)\n";
    let ticket = "no frontmatter, [broken](nowhere.md)\n";
    let draft = "---\nstatus: wip\n---\n";
    let files = [OKF_ROOT, ("a.md", a), ("tickets/t1.md", ticket), ("notes/draft.md", draft), ("draft.md", draft)];
    let mut s = snapshot(&files, &[]);
    s.exclude = Exclude::new(&["tickets/".into(), "**/draft.md".into()]).unwrap();
    let report = lint_snapshot(&s);
    let found: Vec<_> = report.diagnostics.iter().map(|d| (d.path.as_str(), d.code.as_str())).collect();
    // Only `a.md`'s own broken link; the root index is not asked to list `draft.md`.
    assert_eq!(found, vec![("a.md", "broken-link")]);
    assert_eq!((report.files, report.excluded), (2, 3));
    assert!(render_text(&report, ".", false).ends_with("1 error in 2 files (3 excluded)\n"));
}

#[test]
fn an_anchored_pattern_matches_only_at_the_root() {
    let ex = Exclude::new(&["/drafts".into()]).unwrap();
    assert!(ex.matches("drafts/a.md"));
    assert!(!ex.matches("sub/drafts/a.md"));
    assert!(Exclude::new(&["{a".into()]).is_err());
}
