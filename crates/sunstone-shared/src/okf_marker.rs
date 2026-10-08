//! Writing the `okf_version` Bundle-root marker (OKF v0.2 §12, ticket ov-8).
//!
//! The reading side is [`crate::frontmatter::okf_version_of`]; this is the
//! producer side. When Sunstone creates a Bundle it declares the OKF version it
//! targets in the root `index.md`, so the next tool to open it finds the root on
//! rung 1 ([`crate::bundle_root`]) instead of guessing.
//!
//! The marker is the one Frontmatter a Reserved file may carry, so this is the
//! only writer that emits a Frontmatter block into an `index.md`, and callers
//! only ever hand it the **root** `index.md`. [`declare_okf_version`] is pure:
//! it maps the file's current content to the content to write, or `None` when
//! the file must be left alone.

/// The OKF version Sunstone targets, as written into a root `index.md`.
pub const OKF_VERSION: &str = "0.2";

/// The root `index.md` to write so it declares [`OKF_VERSION`], or `None` when
/// the file must not be touched.
///
/// - `existing == None` (no root `index.md` yet): a fresh index with the marker
///   and a `# {title}` heading.
/// - No Frontmatter block: the marker block is prepended; the body is kept
///   byte-for-byte.
/// - A Frontmatter block without the key: `okf_version` is inserted as its
///   first line; every other key and the body are kept byte-for-byte.
/// - A block that already has an `okf_version` key, whatever its value (another
///   version, empty, malformed): `None`. A declaration is never upgraded.
/// - A block whose YAML does not parse to a mapping: `None`. Inserting a line
///   into YAML Sunstone cannot read could only make it worse.
pub fn declare_okf_version(existing: Option<&str>, title: &str) -> Option<String> {
    let line = format!("okf_version: \"{OKF_VERSION}\"");
    let Some(content) = existing else {
        return Some(format!("---\n{line}\n---\n\n# {title}\n"));
    };
    let s = crate::frontmatter::split(content);
    if !s.has_frontmatter {
        let nl = if content.contains("\r\n") { "\r\n" } else { "\n" };
        return Some(format!("---{nl}{line}{nl}---{nl}{content}"));
    }
    let nl = if s.open.ends_with("\r\n") { "\r\n" } else { "\n" };
    if !s.yaml.trim().is_empty() {
        let value: serde_yaml::Value = serde_yaml::from_str(s.yaml).ok()?;
        let map = value.as_mapping()?;
        if map.contains_key(serde_yaml::Value::from("okf_version")) {
            return None;
        }
    }
    Some(format!("{}{line}{nl}{}{}{}", s.open, s.yaml, s.close, s.body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter::{okf_version_of, parse_frontmatter, split};

    #[test]
    fn creates_a_root_index_declaring_the_version() {
        let out = declare_okf_version(None, "Notes").unwrap();
        assert_eq!(out, "---\nokf_version: \"0.2\"\n---\n\n# Notes\n");
        assert_eq!(okf_version_of(&out).as_deref(), Some(OKF_VERSION));
    }

    #[test]
    fn prepends_a_block_to_an_index_without_frontmatter() {
        let body = "# Notes\n\n- [A](a.md)\n";
        let out = declare_okf_version(Some(body), "ignored").unwrap();
        assert_eq!(okf_version_of(&out).as_deref(), Some("0.2"));
        assert_eq!(split(&out).body, body);
    }

    #[test]
    fn adds_the_key_preserving_other_keys_and_body() {
        let src = "---\ntitle: Kunden   # the folder name\ntags: [a, b]\n---\n# Kunden\n\nBody.\n";
        let out = declare_okf_version(Some(src), "x").unwrap();
        assert_eq!(
            out,
            "---\nokf_version: \"0.2\"\ntitle: Kunden   # the folder name\ntags: [a, b]\n---\n# Kunden\n\nBody.\n"
        );
        let parsed = parse_frontmatter(&out);
        assert_eq!(parsed.title.as_deref(), Some("Kunden"));
        assert_eq!(parsed.tags, vec!["a", "b"]);
        assert_eq!(parsed.okf_version.as_deref(), Some("0.2"));
    }

    #[test]
    fn fills_an_empty_block() {
        let out = declare_okf_version(Some("---\n---\n# X\n"), "x").unwrap();
        assert_eq!(out, "---\nokf_version: \"0.2\"\n---\n# X\n");
    }

    #[test]
    fn keeps_crlf_line_endings() {
        let out = declare_okf_version(Some("---\r\ntitle: X\r\n---\r\n# X\r\n"), "x").unwrap();
        assert_eq!(out, "---\r\nokf_version: \"0.2\"\r\ntitle: X\r\n---\r\n# X\r\n");
        let out = declare_okf_version(Some("# X\r\n"), "x").unwrap();
        assert_eq!(out, "---\r\nokf_version: \"0.2\"\r\n---\r\n# X\r\n");
    }

    #[test]
    fn leaves_an_existing_declaration_alone_even_another_version() {
        for src in [
            "---\nokf_version: \"0.2\"\n---\n# X\n",
            "---\ntitle: X\nokf_version: \"0.1\"\n---\n# X\n",
            "---\nokf_version: 0.3\n---\n",
            "---\nokf_version:\n---\n",
        ] {
            assert_eq!(declare_okf_version(Some(src), "x"), None, "{src}");
        }
    }

    #[test]
    fn leaves_unparseable_frontmatter_alone() {
        assert_eq!(declare_okf_version(Some("---\ntitle: [unclosed\n---\n# X\n"), "x"), None);
        assert_eq!(declare_okf_version(Some("---\n- a list\n---\n"), "x"), None);
    }
}
