//! End-to-end: a small Bundle on disk, exported, and the pages read back.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

fn temp(name: &str) -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("sunstone-export-{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(root: &Path, rel: &str, content: &[u8]) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

fn read(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(root.join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

/// A Bundle with a titled root index, a folder with its own index, a
/// wikilink, a relative link, an Embed and a draft folder to exclude.
fn bundle() -> PathBuf {
    let root = temp("bundle");
    write(&root, "index.md", b"---\ntitle: Field Notes\n---\n# Welcome\n\nSee [[setup]].\n");
    write(&root, "guide/index.md", b"---\ntitle: The Guide\n---\n# Guide\n");
    write(
        &root,
        "guide/setup.md",
        b"---\ntype: Concept\ntitle: Setting up\ndescription: How to start\n---\n# Setup\n\n\
          Back [home](../index.md), a [[draft]] and ![shot](shot.png).\n",
    );
    write(&root, "guide/shot.png", b"\x89PNG\r\n\x1a\n");
    write(&root, "drafts/draft.md", b"# Draft\n");
    root
}

#[test]
fn exports_every_concept_as_a_linked_page() {
    let root = bundle();
    let out = temp("out").join("site");
    let report = export_bundle(&root, &out, &Exclude::default()).unwrap();
    assert_eq!(report, ExportReport { pages: 4, attachments: 1 });

    let setup = read(&out, "guide/setup.html");
    assert!(setup.contains("<title>Setting up · Field Notes</title>"), "{setup}");
    assert!(setup.contains(r#"<meta name="description" content="How to start">"#));
    assert!(setup.contains(r#"href="../_sunstone/sunstone.css""#));
    // In-body links point at sibling pages, relative to this one.
    assert!(setup.contains(r#"data-path="index.md" href="../index.html""#), "{setup}");
    assert!(setup.contains(r#"data-path="drafts/draft.md" href="../drafts/draft.html""#), "{setup}");
    assert!(setup.contains(r#"src="shot.png""#), "{setup}");
    // Explorer, crumbs and the Frontmatter.
    assert!(setup.contains(r#"<a href="setup.html" aria-current="page">Setting up</a>"#), "{setup}");
    assert!(setup.contains(r#"<a href="index.html">The Guide</a><span class="sep">/</span>"#), "{setup}");
    assert!(setup.contains(r#"<details class="frontmatter"><summary>Frontmatter</summary>"#));

    let home = read(&out, "index.html");
    assert!(home.contains("<title>Field Notes</title>"), "{home}");
    assert!(home.contains(r#"data-path="guide/setup.md" href="guide/setup.html""#), "{home}");
    // The root index links to setup, so setup lists it as a backlink.
    assert!(setup.contains(r#"<li><a href="../index.html">Field Notes</a></li>"#), "{setup}");

    assert!(out.join("guide/shot.png").is_file());
    assert!(out.join("_sunstone/sunstone.css").is_file());
    assert!(out.join("_sunstone/sunstone.js").is_file());
    assert!(out.join("_sunstone/fonts/jost-latin-wght-normal.woff2").is_file());
}

#[test]
fn excluded_concepts_are_left_out_and_read_as_broken() {
    let root = bundle();
    let out = temp("out");
    let exclude = Exclude::new(&["drafts/".to_string()]).unwrap();
    let report = export_bundle(&root, &out, &exclude).unwrap();
    assert_eq!(report.pages, 3);
    assert!(!out.join("drafts").exists());
    let setup = read(&out, "guide/setup.html");
    assert!(setup.contains(r#"class="internal-link broken" data-path="drafts/draft.md" data-broken="true">"#), "{setup}");
    assert!(!setup.contains("drafts/draft.html"), "{setup}");
}

#[test]
fn a_bundle_without_a_root_index_gets_a_front_page() {
    let root = temp("noindex");
    write(&root, "a.md", b"# A\n");
    write(&root, "sub/b.md", b"---\ntitle: Bee\n---\n# B\n");
    let out = temp("out");
    export_bundle(&root, &out, &Exclude::default()).unwrap();
    let home = read(&out, "index.html");
    assert!(home.contains(r#"<li><a href="a.html">a</a></li>"#), "{home}");
    assert!(home.contains(r#"<li><a href="sub/b.html">Bee</a></li>"#), "{home}");
}

#[test]
fn an_earlier_export_is_replaced_but_other_folders_are_refused() {
    let root = bundle();
    let out = temp("out");
    export_bundle(&root, &out, &Exclude::default()).unwrap();
    write(&out, "stale.html", b"old");
    export_bundle(&root, &out, &Exclude::default()).unwrap();
    assert!(!out.join("stale.html").exists());

    let other = temp("other");
    write(&other, "keep.txt", b"mine");
    let err = export_bundle(&root, &other, &Exclude::default()).unwrap_err();
    assert!(err.contains("not empty"), "{err}");
    assert_eq!(read(&other, "keep.txt"), "mine");
}

#[test]
fn the_output_may_not_overlap_the_bundle() {
    let root = bundle();
    let inside = root.join("site");
    let err = export_bundle(&root, &inside, &Exclude::default()).unwrap_err();
    assert!(err.contains("overlaps"), "{err}");
    assert!(!inside.exists(), "a refused export leaves no folder behind");
    let err = export_bundle(&root, root.parent().unwrap(), &Exclude::default()).unwrap_err();
    assert!(err.contains("overlaps"), "{err}");
}
