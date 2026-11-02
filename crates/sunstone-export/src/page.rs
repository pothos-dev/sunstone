//! One exported page: the rendered Concept inside the export's chrome (the
//! Explorer, folder crumbs, the collapsed Frontmatter and the backlinks), with
//! every in-Bundle link pointing at the sibling `.html` file.

use std::sync::LazyLock;

use regex::Regex;
use sunstone_native::render::RenderPayload;

use crate::href::{page_path, relative_href, root_prefix};
use crate::html::{escape, unescape};

/// Everything a page shows besides its rendered body.
pub struct Page<'a> {
    /// The Concept's bundle-relative path (`guide/setup.md`).
    pub path: &'a str,
    pub title: &'a str,
    /// The Bundle's title, for the sidebar header and `<title>`.
    pub site: &'a str,
    pub rendered: &'a RenderPayload,
    /// The Explorer markup for this page (`tree::explorer_html`).
    pub explorer: &'a str,
    /// Folder crumbs, outermost first: label and, when the folder has an
    /// exported `index.md`, that Concept's path.
    pub crumbs: &'a [(String, Option<String>)],
    /// Concepts linking here: path and label.
    pub backlinks: &'a [(String, String)],
}

/// The page's full HTML document.
pub fn page_html(p: &Page, exported: &dyn Fn(&str) -> bool) -> String {
    let base = root_prefix(p.path);
    let body = rewrite_links(&p.rendered.html, p.path, exported);
    let description = p
        .rendered
        .frontmatter
        .iter()
        .find(|f| f.key == "description")
        .and_then(|f| f.values.first())
        .map(|d| format!(r#"<meta name="description" content="{}">"#, escape(d)))
        .unwrap_or_default();
    let doc_title = if p.title == p.site {
        escape(p.site)
    } else {
        format!("{} · {}", escape(p.title), escape(p.site))
    };
    let home = format!(
        r#"<a class="site" href="{}">{}</a>"#,
        relative_href(p.path, "index.html"),
        escape(p.site)
    );
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{doc_title}</title>
{description}
<link rel="stylesheet" href="{base}_sunstone/sunstone.css">
<script>{THEME_INIT}</script>
<script src="{base}_sunstone/sunstone.js" defer></script>
</head>
<body>
<div class="layout">
<nav class="sidebar" aria-label="Explorer">
<div class="sidebar-head">{home}<button type="button" class="theme-toggle" title="Toggle dark mode" aria-label="Toggle dark mode">◐</button></div>
{explorer}
</nav>
<main class="reader">
<header class="page-head"><button type="button" class="nav-toggle" aria-label="Show the Explorer">☰</button>{crumbs}</header>
{frontmatter}<article class="rendered">
{body}
</article>
{backlinks}</main>
</div>
</body>
</html>
"#,
        explorer = p.explorer,
        crumbs = crumbs_html(p),
        frontmatter = frontmatter_html(p.rendered),
        backlinks = backlinks_html(p),
    )
}

/// Before first paint: mark that scripts run (`html.js`, which shows the
/// script-only controls) and set the theme, the reader's last choice else the
/// OS preference. Inline, so the page never flashes the wrong scheme.
const THEME_INIT: &str = "var r=document.documentElement;r.classList.add('js');\
try{var t=localStorage.getItem('sunstone-export-theme')}catch(e){}\
r.dataset.theme=t||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')";

fn crumbs_html(p: &Page) -> String {
    let mut out = String::from(r#"<nav class="crumbs" aria-label="Folders">"#);
    for (label, index) in p.crumbs {
        match index {
            Some(i) => out.push_str(&format!(
                r#"<a href="{}">{}</a><span class="sep">/</span>"#,
                relative_href(p.path, &page_path(i)),
                escape(label)
            )),
            None => out.push_str(&format!(r#"<span>{}</span><span class="sep">/</span>"#, escape(label))),
        }
    }
    out.push_str(&format!(r#"<span class="here">{}</span></nav>"#, escape(p.title)));
    out
}

/// The Frontmatter as the read-only Properties grid, collapsed as on the
/// desktop and the web reader.
fn frontmatter_html(r: &RenderPayload) -> String {
    if r.frontmatter.is_empty() {
        return String::new();
    }
    let mut out = String::from(r#"<details class="frontmatter"><summary>Frontmatter</summary><dl class="properties">"#);
    for f in &r.frontmatter {
        out.push_str(&format!("<dt>{}</dt><dd>", escape(&f.key)));
        if f.values.len() > 1 {
            out.push_str(r#"<ul class="prop-list">"#);
            for v in &f.values {
                out.push_str(&format!("<li>{}</li>", escape(v)));
            }
            out.push_str("</ul>");
        } else {
            out.push_str(&escape(f.values.first().map_or("", String::as_str)));
        }
        out.push_str("</dd>");
    }
    out.push_str("</dl></details>\n");
    out
}

fn backlinks_html(p: &Page) -> String {
    if p.backlinks.is_empty() {
        return String::new();
    }
    let mut out = String::from(r#"<aside class="backlinks"><h2>Linked from</h2><ul>"#);
    for (path, label) in p.backlinks {
        out.push_str(&format!(
            r#"<li><a href="{}">{}</a></li>"#,
            relative_href(p.path, &page_path(path)),
            escape(label)
        ));
    }
    out.push_str("</ul></aside>\n");
    out
}

/// Point every in-Bundle link of the rendered body at its exported page,
/// relative to `from`. The renderer marks those links with `data-path`; a link
/// to a Concept left out of the export reads as broken, like a missing one,
/// and a broken link loses its `href`: there is no page to go to.
pub fn rewrite_links(html: &str, from: &str, exported: &dyn Fn(&str) -> bool) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"class="internal-link( broken)?" data-path="([^"]*)"( data-broken="true")? href="[^"]*""#)
            .unwrap()
    });
    RE.replace_all(html, |caps: &regex::Captures| {
        let raw = &caps[2];
        let path = unescape(raw);
        if caps.get(1).is_none() && exported(&path) {
            format!(
                r#"class="internal-link" data-path="{raw}" href="{}""#,
                relative_href(from, &page_path(&path))
            )
        } else {
            format!(r#"class="internal-link broken" data-path="{raw}" data-broken="true""#)
        }
    })
    .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_links_point_at_sibling_pages() {
        let html = r#"<a class="internal-link" data-path="guide/a b.md" href="/guide/a%20b">x</a>"#;
        assert_eq!(
            rewrite_links(html, "guide/index.md", &|_| true),
            r#"<a class="internal-link" data-path="guide/a b.md" href="a%20b.html">x</a>"#
        );
        assert_eq!(
            rewrite_links(html, "other/deep/c.md", &|_| true),
            r#"<a class="internal-link" data-path="guide/a b.md" href="../../guide/a%20b.html">x</a>"#
        );
    }

    #[test]
    fn broken_and_excluded_links_lose_their_href() {
        let broken = r#"<a class="internal-link broken" data-path="nope.md" data-broken="true" href="/nope">x</a>"#;
        let expect = r#"<a class="internal-link broken" data-path="nope.md" data-broken="true">x</a>"#;
        assert_eq!(rewrite_links(broken, "a.md", &|_| true), expect);
        let excluded = r#"<a class="internal-link" data-path="nope.md" href="/nope">x</a>"#;
        assert_eq!(rewrite_links(excluded, "a.md", &|_| false), expect);
    }

    #[test]
    fn an_escaped_data_path_resolves_unescaped() {
        let html = r#"<a class="internal-link" data-path="a&amp;b.md" href="/a%26b">x</a>"#;
        assert!(rewrite_links(html, "c.md", &|p| p == "a&b.md").contains(r#"href="a%26b.html""#));
    }
}
