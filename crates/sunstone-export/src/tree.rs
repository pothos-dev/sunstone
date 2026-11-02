//! The Explorer of an exported page: the Bundle's folders and Concepts as
//! nested `<details>` lists, built into every page so it works without
//! JavaScript. It follows the desktop Explorer's rules (`src/lib/treeNav.ts`):
//! folders first, a Concept labelled by its `title`, a folder by its
//! `index.md`'s `title` and opening that `index.md` (ADR 0018), and the reserved
//! `index.md` / `log.md` not listed as rows of their own.

use sunstone_native::bundle::TreeNode;

use crate::href::{page_path, relative_href};
use crate::html::escape;

/// The Explorer list for the page of `current`. Only Concepts `exported`
/// reports are listed; a folder with none of them is left out.
pub fn explorer_html(root: &TreeNode, current: &str, exported: &dyn Fn(&str) -> bool) -> String {
    let mut out = String::from(r#"<ul class="tree">"#);
    for child in children(root) {
        push_node(&mut out, child, current, exported);
    }
    out.push_str("</ul>");
    out
}

/// A Concept's label: its frontmatter `title`, else its filename without `.md`.
pub fn concept_label(node: &TreeNode) -> String {
    node.title
        .clone()
        .unwrap_or_else(|| node.name.strip_suffix(".md").unwrap_or(&node.name).to_string())
}

/// The `index.md` directly under folder `node`, if any.
pub fn index_child(node: &TreeNode) -> Option<&TreeNode> {
    node.children.as_deref()?.iter().find(|c| !c.is_dir && c.name == "index.md")
}

fn push_node(out: &mut String, node: &TreeNode, current: &str, exported: &dyn Fn(&str) -> bool) {
    if node.is_dir {
        if !has_exported(node, exported) {
            return;
        }
        let index = index_child(node).filter(|i| exported(&i.path));
        let label = index.and_then(|i| i.title.clone()).unwrap_or_else(|| node.name.clone());
        let open = current.starts_with(&format!("{}/", node.path));
        out.push_str(if open { "<li><details open><summary>" } else { "<li><details><summary>" });
        match index {
            Some(i) => out.push_str(&link(&i.path, current, &label)),
            None => out.push_str(&format!("<span>{}</span>", escape(&label))),
        }
        out.push_str("</summary><ul>");
        for child in children(node) {
            push_node(out, child, current, exported);
        }
        out.push_str("</ul></details></li>");
    } else if exported(&node.path) {
        out.push_str("<li>");
        out.push_str(&link(&node.path, current, &concept_label(node)));
        out.push_str("</li>");
    }
}

fn link(path: &str, current: &str, label: &str) -> String {
    let aria = if path == current { r#" aria-current="page""# } else { "" };
    format!(
        r#"<a href="{}"{aria}>{}</a>"#,
        relative_href(current, &page_path(path)),
        escape(label)
    )
}

/// A folder's rows: sub-folders and Concepts, without the reserved files and
/// without non-markdown files. `list_tree` already sorts folders first.
fn children(node: &TreeNode) -> impl Iterator<Item = &TreeNode> {
    node.children.as_deref().unwrap_or_default().iter().filter(|c| {
        c.is_dir || (c.name.ends_with(".md") && c.name != "index.md" && c.name != "log.md")
    })
}

fn has_exported(node: &TreeNode, exported: &dyn Fn(&str) -> bool) -> bool {
    match &node.children {
        Some(kids) => kids.iter().any(|c| has_exported(c, exported)),
        None => node.name.ends_with(".md") && exported(&node.path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, title: Option<&str>) -> TreeNode {
        TreeNode {
            name: path.rsplit('/').next().unwrap().to_string(),
            path: path.to_string(),
            is_dir: false,
            title: title.map(str::to_string),
            status: None,
            stale_after: None,
            children: None,
        }
    }

    fn dir(path: &str, children: Vec<TreeNode>) -> TreeNode {
        TreeNode {
            name: path.rsplit('/').next().unwrap().to_string(),
            path: path.to_string(),
            is_dir: true,
            title: None,
            status: None,
            stale_after: None,
            children: Some(children),
        }
    }

    fn bundle() -> TreeNode {
        dir(
            "",
            vec![
                dir("empty", vec![file("empty/pic.png", None)]),
                dir(
                    "guide",
                    vec![file("guide/index.md", Some("The Guide")), file("guide/setup.md", None)],
                ),
                dir("loose", vec![file("loose/a.md", Some("A & B"))]),
                file("index.md", None),
                file("log.md", None),
                file("top.md", None),
            ],
        )
    }

    #[test]
    fn folders_open_their_index_and_reserved_files_have_no_row() {
        let html = explorer_html(&bundle(), "top.md", &|_| true);
        assert!(html.contains(r#"<summary><a href="guide/index.html">The Guide</a></summary>"#), "{html}");
        assert!(html.contains(r#"<summary><span>loose</span></summary>"#), "{html}");
        assert!(html.contains(r#"<a href="loose/a.html">A &amp; B</a>"#), "{html}");
        assert!(!html.contains("log.html"), "{html}");
        assert!(!html.contains(r#"href="index.html""#), "{html}");
        // A folder with no Concept in it is not listed.
        assert!(!html.contains("empty"), "{html}");
    }

    #[test]
    fn the_current_page_is_marked_and_its_folders_open() {
        let html = explorer_html(&bundle(), "guide/setup.md", &|_| true);
        assert!(html.contains(r#"<li><details open><summary><a href="index.html">The Guide</a>"#), "{html}");
        assert!(html.contains(r#"<a href="setup.html" aria-current="page">setup</a>"#), "{html}");
        assert!(html.contains(r#"<li><details><summary><span>loose</span>"#), "{html}");
        assert!(html.contains(r#"<a href="../top.html">top</a>"#), "{html}");
    }

    #[test]
    fn excluded_concepts_drop_out() {
        let html = explorer_html(&bundle(), "top.md", &|p| !p.starts_with("loose/"));
        assert!(!html.contains("loose"), "{html}");
    }
}
