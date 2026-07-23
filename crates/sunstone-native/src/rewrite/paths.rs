//! Pure path math for the move/rename engine: relative-path computation and
//! wikilink basename / shortest-resolving-suffix. The URL `split_suffix` and
//! `utf8_len` helpers moved to `sunstone-shared::rewrite::paths` (family 10);
//! the engine imports them from there.
//!
//! All bundle-relative, '/'-separated; mirrors `index.rs` EXACTLY (`.`/`..`
//! collapse, leading-`..` escapes dropped). No IO — each function is a pure
//! transform, exhaustively unit-testable.

use sunstone_shared::wikilink::{self, basename, drop_md};

/// Basename (after the last `/`) of a bundle path, with `.md` dropped — the
/// literal filename to write into a rewritten wikilink (preserves new casing).
pub(super) fn basename_of(path: &str) -> &str {
    drop_md(basename(path))
}

/// The shortest path SUFFIX of `target` (a bundle path, `.md` dropped) that,
/// resolved as a wikilink against `paths`, lands back on `target`. Starts at the
/// basename and adds leading segments until resolution is unambiguous, falling
/// back to the full path. Keeps a rewritten partial-path wikilink pointing at
/// the moved file.
pub(super) fn shortest_resolving_suffix(paths: &[String], source: &str, target: &str) -> String {
    let no_ext = drop_md(target);
    let segments: Vec<&str> = no_ext.split('/').collect();
    // Try suffixes from shortest (basename) to longest (full path).
    for take in 1..=segments.len() {
        let suffix = segments[segments.len() - take..].join("/");
        if wikilink::resolve_wikilink(paths, source, &suffix).as_deref() == Some(target) {
            return suffix;
        }
    }
    // Fallback: the full path without extension (should always resolve).
    no_ext.to_string()
}

/// Compute the relative path string FROM `from_dir` TO the bundle-relative
/// `target`, preferring an explicit `./` for a same-directory target and `../`
/// for ancestors (the Obsidian/markdown convention authors expect). Both inputs
/// are bundle-relative, '/'-separated; `from_dir` is '' for the bundle root.
pub(super) fn relative_path(from_dir: &str, target: &str) -> String {
    let from: Vec<&str> = if from_dir.is_empty() {
        Vec::new()
    } else {
        from_dir.split('/').collect()
    };
    let to: Vec<&str> = if target.is_empty() {
        Vec::new()
    } else {
        target.split('/').collect()
    };

    // Drop the common leading prefix.
    let mut common = 0usize;
    while common < from.len() && common < to.len() && from[common] == to[common] {
        common += 1;
    }

    let ups = from.len() - common;
    let downs = &to[common..];

    let mut parts: Vec<String> = Vec::new();
    for _ in 0..ups {
        parts.push("..".to_string());
    }
    for d in downs {
        parts.push((*d).to_string());
    }

    if parts.is_empty() {
        // target == from_dir (a directory) — should not happen for a Concept.
        return ".".to_string();
    }
    // Prefix with `./` when the path does not already start with `..` so the
    // link is unambiguously relative (matches how `./x.md` is authored).
    if parts[0] == ".." {
        parts.join("/")
    } else {
        format!("./{}", parts.join("/"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_path_helper_cases() {
        assert_eq!(relative_path("", "b.md"), "./b.md");
        assert_eq!(relative_path("sub", "folder/b.md"), "../folder/b.md");
        assert_eq!(relative_path("folder", "d.md"), "../d.md");
        assert_eq!(relative_path("a/b", "a/c.md"), "../c.md");
        assert_eq!(relative_path("a", "a/c.md"), "./c.md");
        assert_eq!(relative_path("a/b/c", "x.md"), "../../../x.md");
    }

    #[test]
    fn basename_of_drops_dir_and_extension() {
        assert_eq!(basename_of("a/b/c.md"), "c");
        assert_eq!(basename_of("c.md"), "c");
        assert_eq!(basename_of("a/b/c.MD"), "c"); // case-insensitive `.md`
        assert_eq!(basename_of("a/b/file"), "file"); // no extension
    }

    #[test]
    fn shortest_resolving_suffix_grows_only_when_ambiguous() {
        // Unique basename: the basename alone resolves.
        let unique = vec!["folder/unique.md".to_string()];
        assert_eq!(
            shortest_resolving_suffix(&unique, "src.md", "folder/unique.md"),
            "unique"
        );

        // Ambiguous basename across two dirs. The lexicographically-first path
        // (`a/note.md`) still resolves from the bare basename...
        let ambiguous = vec!["a/note.md".to_string(), "b/note.md".to_string()];
        assert_eq!(
            shortest_resolving_suffix(&ambiguous, "src.md", "a/note.md"),
            "note"
        );
        // ...but the later one needs a leading segment to disambiguate.
        assert_eq!(
            shortest_resolving_suffix(&ambiguous, "src.md", "b/note.md"),
            "b/note"
        );
    }
}
