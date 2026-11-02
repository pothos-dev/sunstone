//! `sunstone export`: a Bundle as a folder of static HTML pages.
//!
//! Every Concept becomes a sibling `.html` file (`guide/setup.md` →
//! `guide/setup.html`), rendered by the same `sunstone_native::render` the web
//! reader uses, so links, wikilinks, Embeds, CriticMarkup, citations,
//! footnotes and the Sources section read the same. All links are relative and
//! the only script is optional (theme toggle, remote images, the narrow-screen
//! Explorer), so the folder opens straight from disk: no server, no backend.
//!
//! This is its own crate, not a `sunstone-native` module, because it embeds the
//! frontend's stylesheets (`src/app.css`, `src/lib/rendered.css`) and the
//! server's Docker build copies only `crates/`.

mod assets;
pub mod cli;
mod href;
mod html;
mod page;
mod tree;

use std::collections::{HashMap, HashSet};
use std::path::Path;

use sunstone_native::bundle::{self, TreeNode};
use sunstone_native::index::Index;
use sunstone_native::lint::Exclude;
use sunstone_native::render::{render_body, RenderPayload};

use href::{page_path, relative_href};
use page::{page_html, Page};
use tree::{concept_label, explorer_html, index_child};

/// What an export wrote.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ExportReport {
    /// Concepts written as pages.
    pub pages: usize,
    /// Attachments copied.
    pub attachments: usize,
}

/// Export the Bundle at `root` into the folder `out`, leaving out the Concepts
/// and Attachments `exclude` matches. `out` must be empty, missing, or an
/// earlier export (which is replaced); it may not overlap the Bundle.
pub fn export_bundle(root: &Path, out: &Path, exclude: &Exclude) -> Result<ExportReport, String> {
    let root = root.canonicalize().map_err(|e| format!("{}: {e}", root.display()))?;
    let out = assets::prepare_out(&root, out)?;

    let index = Index::build(&root);
    let tree = bundle::list_tree(&root)?;
    let all_paths = index.concept_paths();
    let concepts: Vec<&String> = all_paths.iter().filter(|p| !exclude.matches(p)).collect();
    let exported_set: HashSet<&str> = concepts.iter().map(|p| p.as_str()).collect();
    let exported = |p: &str| exported_set.contains(p);
    let attachments: Vec<String> =
        index.attachment_paths().into_iter().filter(|p| !exclude.matches(p)).collect();

    let site = site_title(&tree, &root);
    let labels = labels(&tree);
    let label_of = |p: &str| labels.get(p).cloned().unwrap_or_else(|| p.to_string());

    for path in &concepts {
        let content = bundle::read_concept(&root, path)?;
        let rendered = render_body(
            &content,
            path,
            &all_paths,
            &|p| index.concept_exists(p),
            &attachments,
            &|a| relative_href(path, a),
        );
        let mut backlinks: Vec<(String, String)> = index
            .backlinks(path)
            .into_iter()
            .filter(|b| exported(b) && b != *path)
            .map(|b| {
                let label = label_of(&b);
                (b, label)
            })
            .collect();
        backlinks.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
        write_page(
            &out,
            &Page {
                path,
                title: &label_of(path),
                site: &site,
                rendered: &rendered,
                explorer: &explorer_html(&tree, path, &exported),
                crumbs: &crumbs(&tree, path, &exported),
                backlinks: &backlinks,
            },
            &exported,
        )?;
    }

    // Without a root `index.md` there is still a front page to land on.
    if !exported("index.md") {
        let rendered = landing(&site, &concepts, &label_of);
        write_page(
            &out,
            &Page {
                path: "index.md",
                title: &site,
                site: &site,
                rendered: &rendered,
                explorer: &explorer_html(&tree, "index.md", &exported),
                crumbs: &[],
                backlinks: &[],
            },
            &exported,
        )?;
    }

    for a in &attachments {
        let dest = out.join(a);
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        std::fs::copy(root.join(a), &dest).map_err(|e| format!("{a}: {e}"))?;
    }
    assets::write_assets(&out)?;

    Ok(ExportReport { pages: concepts.len(), attachments: attachments.len() })
}

fn write_page(out: &Path, page: &Page, exported: &dyn Fn(&str) -> bool) -> Result<(), String> {
    let dest = out.join(page_path(page.path));
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    std::fs::write(&dest, page_html(page, exported)).map_err(|e| format!("{}: {e}", dest.display()))
}

/// The Bundle's title: the root `index.md`'s `title`, else the folder name.
fn site_title(tree: &TreeNode, root: &Path) -> String {
    index_child(tree).and_then(|i| i.title.clone()).unwrap_or_else(|| {
        root.file_name().map_or_else(|| "Bundle".to_string(), |n| n.to_string_lossy().into_owned())
    })
}

/// Every Concept's page title: its `title`, else its filename; an untitled
/// `index.md` is named after its folder (the root one: the Bundle's folder).
fn labels(tree: &TreeNode) -> HashMap<String, String> {
    fn walk(node: &TreeNode, map: &mut HashMap<String, String>) {
        for c in node.children.as_deref().unwrap_or_default() {
            if c.is_dir {
                walk(c, map);
            } else if c.name.ends_with(".md") {
                let label = match (&c.title, c.name.as_str()) {
                    (None, "index.md") => node.name.clone(),
                    _ => concept_label(c),
                };
                map.insert(c.path.clone(), label);
            }
        }
    }
    let mut map = HashMap::new();
    walk(tree, &mut map);
    map
}

/// The folders above `path`'s page, outermost first: each one's label and its
/// exported `index.md`. A folder's own `index.md` page starts at its parent.
fn crumbs(tree: &TreeNode, path: &str, exported: &dyn Fn(&str) -> bool) -> Vec<(String, Option<String>)> {
    let mut segs: Vec<&str> = path.split('/').collect();
    segs.pop();
    if path.ends_with("/index.md") || path == "index.md" {
        segs.pop();
    }
    let mut out = Vec::new();
    let mut node = tree;
    for seg in segs {
        let Some(next) = node.children.as_deref().unwrap_or_default().iter().find(|c| c.is_dir && c.name == seg)
        else {
            break;
        };
        node = next;
        let index = index_child(node).filter(|i| exported(&i.path));
        let label = index.and_then(|i| i.title.clone()).unwrap_or_else(|| node.name.clone());
        out.push((label, index.map(|i| i.path.clone())));
    }
    out
}

/// The generated front page of a Bundle without a root `index.md`: every
/// exported Concept, as a list.
fn landing(site: &str, concepts: &[&String], label_of: &dyn Fn(&str) -> String) -> RenderPayload {
    let mut html = format!("<h1>{}</h1>\n<ul>\n", html::escape(site));
    for path in concepts {
        html.push_str(&format!(
            r#"<li><a href="{}">{}</a></li>"#,
            relative_href("index.md", &page_path(path)),
            html::escape(&label_of(path))
        ));
        html.push('\n');
    }
    html.push_str("</ul>\n");
    RenderPayload { html, frontmatter: vec![], outline: vec![], trust: None, source_count: 0 }
}

#[cfg(test)]
mod tests;
