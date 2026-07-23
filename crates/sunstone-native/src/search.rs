//! Full-text (body content) search across the Bundle, on demand.
//!
//! Backed by the ripgrep libraries (NO external `rg` binary): a
//! `grep_regex::RegexMatcher` drives a `grep_searcher::Searcher` over every
//! `.md` file found by walking the Bundle with the `ignore` crate (same walker
//! `bundle.rs` uses, so `.gitignore`/hidden rules match the tree). Results are a
//! flat list of matches ordered by path then line.
//!
//! The default query is forgiving: a case-insensitive LITERAL substring search
//! (the user's text is escaped, so regex metacharacters are matched verbatim).
//! This keeps the affordance a "find text" box, not a regex console.
//!
//! Pure module logic — the `#[tauri::command]` wrapper in `lib.rs` stays thin.

use std::path::Path;

use grep_regex::RegexMatcher;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use serde::Serialize;

use crate::paths::md_files;

/// Hard cap on the number of matches returned, so a query like a single common
/// letter over a huge Bundle cannot flood the IPC channel or the UI list. The
/// search stops walking once this many matches are collected. Documented in the
/// `Backend.search` contract; the frontend shows the (capped) list as-is.
const MAX_RESULTS: usize = 500;

/// One full-text match. Matches the TS `SearchHit`
/// (`serde rename_all = "camelCase"`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// bundle-relative, '/'-separated path of the Concept the match is in.
    pub path: String,
    /// 1-based line number of the match within the file.
    pub line: u64,
    /// the matching line's text (trimmed of the trailing newline).
    pub snippet: String,
}

/// Search every `.md` Concept body in the Bundle for `query`, returning matches
/// ordered by path then line, capped at [`MAX_RESULTS`]. An empty/whitespace
/// query yields no matches (the frontend doesn't search until there is input).
///
/// The query is treated as a case-insensitive literal: regex metacharacters in
/// it are escaped, so it behaves like a plain "find this text" box.
pub fn search(root: &Path, query: &str) -> Result<Vec<SearchHit>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    // Case-insensitive literal search: escape the user text so metacharacters
    // are matched verbatim, then compile with the `i` flag.
    let pattern = format!("(?i){}", regex_escape(trimmed));
    let matcher = RegexMatcher::new(&pattern).map_err(|e| e.to_string())?;

    let mut hits: Vec<SearchHit> = Vec::new();

    'walk: for (path, rel) in md_files(root) {
        let mut searcher = SearcherBuilder::new()
            .binary_detection(BinaryDetection::quit(b'\x00'))
            .line_number(true)
            .build();

        // Collect matches for this file. The UTF8 sink hands us each matching
        // line with its 1-based line number; we stop early once the global cap
        // is reached.
        let mut file_hits: Vec<SearchHit> = Vec::new();
        let mut capped = false;
        let search_result = searcher.search_path(
            &matcher,
            path,
            UTF8(|line_number, line| {
                file_hits.push(SearchHit {
                    path: rel.clone(),
                    line: line_number,
                    snippet: line.trim_end_matches(['\n', '\r']).to_string(),
                });
                if hits.len() + file_hits.len() >= MAX_RESULTS {
                    capped = true;
                    return Ok(false); // stop searching this file
                }
                Ok(true)
            }),
        );
        // A per-file search error (e.g. invalid UTF-8) shouldn't abort the whole
        // search: skip the file and carry on.
        if search_result.is_ok() {
            hits.extend(file_hits);
        }
        if capped || hits.len() >= MAX_RESULTS {
            break 'walk;
        }
    }

    // Order by path, then line, for a stable, sensible grouping.
    hits.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    hits.truncate(MAX_RESULTS);
    Ok(hits)
}

/// Escape regex metacharacters so a user query is matched as a literal string.
fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if "\\.+*?()|[]{}^$#".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_root() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sunstone-search-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn finds_matches_case_insensitively_across_files() {
        let root = temp_root();
        std::fs::write(root.join("a.md"), "# Title\nThe Quick brown fox\nanother line\n").unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/b.md"), "nothing here\nquick again\n").unwrap();
        // A non-md file must be ignored.
        std::fs::write(root.join("c.txt"), "quick in a text file\n").unwrap();

        let hits = search(&root, "quick").unwrap();
        assert_eq!(hits.len(), 2);
        // Ordered by path then line.
        assert_eq!(hits[0].path, "a.md");
        assert_eq!(hits[0].line, 2);
        assert!(hits[0].snippet.contains("Quick brown fox"));
        assert_eq!(hits[1].path, "sub/b.md");
        assert_eq!(hits[1].line, 2);
    }

    #[test]
    fn empty_query_returns_nothing() {
        let root = temp_root();
        std::fs::write(root.join("a.md"), "some content\n").unwrap();
        assert!(search(&root, "   ").unwrap().is_empty());
        assert!(search(&root, "").unwrap().is_empty());
    }

    #[test]
    fn query_is_treated_as_literal() {
        let root = temp_root();
        std::fs::write(root.join("a.md"), "a.b match\naxb no match\n").unwrap();
        // "a.b" as a literal matches only the line with a real dot, not "axb".
        let hits = search(&root, "a.b").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 1);
    }
}
