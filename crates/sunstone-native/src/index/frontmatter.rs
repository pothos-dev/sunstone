//! Leading YAML frontmatter parsing for the Bundle index.
//!
//! Extracts only the aggregates the index needs (`type`, `tags`, and the
//! distinct top-level keys) and exposes the block-finding / stripping helpers
//! the link extractor reuses. The Properties panel owns verbatim
//! round-tripping; broken/invalid frontmatter is tolerated, never blocked
//! (docs/GLOSSARY.md).

/// The frontmatter fields the index cares about, parsed from a Concept's leading
/// YAML block.
#[derive(Debug, Default, Clone)]
pub(super) struct ParsedFrontmatter {
    /// `type` scalar, if present and non-empty.
    pub(super) concept_type: Option<String>,
    /// `tags` flat list; empty when absent.
    pub(super) tags: Vec<String>,
    /// Distinct top-level frontmatter keys.
    pub(super) keys: Vec<String>,
}

/// Parse the leading YAML frontmatter block (delimited by `---`) and extract
/// `type` (scalar), `tags` (flat list), and the distinct top-level keys.
/// Tolerates missing/invalid frontmatter: returns a default (all-empty)
/// `ParsedFrontmatter` rather than erroring (docs/GLOSSARY.md — broken Concepts are
/// never blocked).
pub(super) fn parse_frontmatter(content: &str) -> ParsedFrontmatter {
    let Some(block) = frontmatter_block(content) else {
        return ParsedFrontmatter::default();
    };
    let value: serde_yaml::Value = match serde_yaml::from_str(block) {
        Ok(v) => v,
        Err(_) => return ParsedFrontmatter::default(),
    };
    let Some(map) = value.as_mapping() else {
        return ParsedFrontmatter::default();
    };

    let concept_type = map
        .get(serde_yaml::Value::from("type"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());

    let tags = map
        .get(serde_yaml::Value::from("tags"))
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let keys = map
        .keys()
        .filter_map(|k| k.as_str().map(|s| s.to_string()))
        .collect();

    ParsedFrontmatter {
        concept_type,
        tags,
        keys,
    }
}

/// Locate the leading `---`-fenced frontmatter block. Returns `(block, body)`
/// where `block` is the YAML text between the fences and `body` is everything
/// after the closing fence line, or `None` if the content does not open with a
/// frontmatter block. The block must start on the very first line (`---\n`) per
/// the OKF/Obsidian convention.
///
/// Both halves are derived from a single forward scan so the body offset can
/// never disagree with the block (an earlier `content.find(block)` approach
/// mislocated an empty block at offset 0 and leaked the closing fence).
pub fn split_frontmatter(content: &str) -> Option<(&str, &str)> {
    // Tolerate a leading BOM / CRLF opener.
    let opener = if content.starts_with("---\n") {
        "---\n"
    } else if content.starts_with("---\r\n") {
        "---\r\n"
    } else {
        return None;
    };
    let rest = &content[opener.len()..];
    // Find the closing fence: a line that is exactly `---`.
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" {
            let block = &rest[..offset];
            // The body begins after the whole closing-fence line (which may be
            // the end of the content, leaving an empty body).
            let body = &rest[offset + line.len()..];
            return Some((block, body));
        }
        offset += line.len();
    }
    None
}

/// Return the YAML text between the leading `---` fences, or `None` if the
/// content does not open with a frontmatter block.
pub fn frontmatter_block(content: &str) -> Option<&str> {
    split_frontmatter(content).map(|(block, _)| block)
}

/// Strip the leading frontmatter block so a `---` or link-like text inside it is
/// not mistaken for body content.
pub fn strip_frontmatter(content: &str) -> &str {
    match split_frontmatter(content) {
        Some((_, body)) => body,
        None => content,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_type_and_tags() {
        let md = "---\ntype: concept\ntags: [a, b]\n---\n\n# Body\n";
        let fm = parse_frontmatter(md);
        assert_eq!(fm.concept_type.as_deref(), Some("concept"));
        assert_eq!(fm.tags, vec!["a", "b"]);
        assert_eq!(fm.keys, vec!["type", "tags"]);
    }

    #[test]
    fn tolerates_missing_frontmatter() {
        let fm = parse_frontmatter("# Just a body, no frontmatter\n");
        assert!(fm.concept_type.is_none());
        assert!(fm.tags.is_empty());
        assert!(fm.keys.is_empty());
    }

    #[test]
    fn tolerates_empty_type() {
        let fm = parse_frontmatter("---\ntype:\ntitle: x\n---\n");
        assert!(fm.concept_type.is_none());
        // Even when `type` is empty, its KEY is still present (autocomplete).
        assert_eq!(fm.keys, vec!["type", "title"]);
    }

    #[test]
    fn strip_removes_a_normal_frontmatter_block() {
        assert_eq!(
            strip_frontmatter("---\ntype: concept\n---\n# Body\n"),
            "# Body\n"
        );
    }

    #[test]
    fn strip_removes_an_empty_frontmatter_block() {
        // An empty block (`---\n---\n`) must not leak its closing fence into the
        // body — the body here is just "x\n".
        assert_eq!(strip_frontmatter("---\n---\nx\n"), "x\n");
    }

    #[test]
    fn strip_passes_through_content_without_frontmatter() {
        assert_eq!(strip_frontmatter("# Body\n---\nx\n"), "# Body\n---\nx\n");
    }

    #[test]
    fn strip_handles_a_closing_fence_with_no_trailing_newline() {
        // Body is empty when the file ends right after the closing fence.
        assert_eq!(strip_frontmatter("---\ntype: x\n---"), "");
    }
}
