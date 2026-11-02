//! Where each Concept lands in the export, and the relative `href` from one
//! exported page to another file. Every link is relative, so the folder opens
//! from disk (`file://`) as well as from any web server path.

use sunstone_shared::paths::dir_of;
use sunstone_shared::url::query_encode;

/// The exported file for the Concept at `concept`: `a/b.md` → `a/b.html`.
pub fn page_path(concept: &str) -> String {
    match concept.strip_suffix(".md") {
        Some(stem) => format!("{stem}.html"),
        None => format!("{concept}.html"),
    }
}

/// The relative URL from the page exported for `from_concept` to the
/// bundle-relative file `to`, each segment percent-encoded.
pub fn relative_href(from_concept: &str, to: &str) -> String {
    let from_dir: Vec<&str> = split(dir_of(from_concept));
    let to_segs: Vec<&str> = split(to);
    let common = from_dir
        .iter()
        .zip(&to_segs)
        .take_while(|(a, b)| a == b)
        .count()
        // The last segment of `to` is the file itself, never a shared folder.
        .min(to_segs.len().saturating_sub(1));
    let mut parts: Vec<String> = vec!["..".to_string(); from_dir.len() - common];
    parts.extend(to_segs[common..].iter().map(|s| query_encode(s)));
    parts.join("/")
}

/// The prefix that leads from `from_concept`'s page back to the export root:
/// `""` at the top level, `"../"` one folder down, and so on.
pub fn root_prefix(from_concept: &str) -> String {
    "../".repeat(split(dir_of(from_concept)).len())
}

fn split(path: &str) -> Vec<&str> {
    path.split('/').filter(|s| !s.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_path_swaps_the_extension() {
        assert_eq!(page_path("index.md"), "index.html");
        assert_eq!(page_path("guide/setup.md"), "guide/setup.html");
    }

    #[test]
    fn relative_href_walks_up_and_down() {
        assert_eq!(relative_href("a.md", "b.html"), "b.html");
        assert_eq!(relative_href("a.md", "x/y.html"), "x/y.html");
        assert_eq!(relative_href("x/a.md", "x/y.html"), "y.html");
        assert_eq!(relative_href("x/z/a.md", "x/y.html"), "../y.html");
        assert_eq!(relative_href("x/a.md", "index.html"), "../index.html");
        assert_eq!(relative_href("p/q/a.md", "r/s.png"), "../../r/s.png");
    }

    #[test]
    fn relative_href_encodes_each_segment() {
        assert_eq!(relative_href("a.md", "my notes/b c#1.html"), "my%20notes/b%20c%231.html");
    }

    #[test]
    fn a_file_named_like_a_folder_is_not_shared() {
        // `x/a.md` linking to the file `x` (no folder in common with itself).
        assert_eq!(relative_href("x/a.md", "x"), "../x");
    }

    #[test]
    fn root_prefix_counts_folders() {
        assert_eq!(root_prefix("index.md"), "");
        assert_eq!(root_prefix("a/b/c.md"), "../../");
    }
}
