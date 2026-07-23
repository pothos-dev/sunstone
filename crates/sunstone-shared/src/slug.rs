//! GitHub-style heading slugs.
//!
//! MUST mirror `slugify` in `src/lib/slug.ts` EXACTLY, the same way
//! `wikilink::resolve_wikilink` mirrors `resolveWikilink`: the anchor-rewrite
//! (`rewrite/anchors.rs`) compares a link's anchor slug to a rename's old slug,
//! and the frontend computes those old/new slugs with the TS `slugify`, so the
//! two implementations have to agree.
//!
//! Algorithm (see the TS module for the rationale): trim, lowercase, then keep
//! letters/digits/`-`/`_`, turn each whitespace char into `-`, and drop
//! everything else. No de-duplication here — that is document-order state the
//! frontend owns; the backend only ever slugs a single anchor string.

/// GitHub-style slug for a single heading / anchor string (no de-duplication).
pub fn slugify(text: &str) -> String {
    let mut out = String::new();
    for ch in text.trim().to_lowercase().chars() {
        if ch.is_whitespace() {
            out.push('-');
        } else if ch == '-' || ch == '_' {
            out.push(ch);
        } else if ch.is_alphanumeric() {
            out.push(ch);
        }
        // everything else (punctuation, symbols) is dropped
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lowercases_and_hyphenates_spaces() {
        assert_eq!(slugify("Deep Section"), "deep-section");
        assert_eq!(slugify("Hello World"), "hello-world");
    }

    #[test]
    fn drops_punctuation_and_symbols() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(slugify("What is C++?"), "what-is-c");
        assert_eq!(slugify("foo.bar"), "foobar");
        assert_eq!(slugify("50% off"), "50-off");
    }

    #[test]
    fn keeps_hyphens_and_underscores() {
        assert_eq!(slugify("already-slugged"), "already-slugged");
        assert_eq!(slugify("snake_case_name"), "snake_case_name");
    }

    #[test]
    fn runs_of_whitespace_become_runs_of_hyphens() {
        assert_eq!(slugify("a  b"), "a--b");
    }

    #[test]
    fn trims_leading_and_trailing_whitespace() {
        assert_eq!(slugify("  Setup  "), "setup");
        assert_eq!(slugify(" deep section "), "deep-section");
    }

    #[test]
    fn keeps_digits_and_unicode_letters() {
        assert_eq!(slugify("Section 2"), "section-2");
        assert_eq!(slugify("Café Menu"), "café-menu");
    }

    #[test]
    fn literal_and_slug_forms_collide() {
        // Backward-compat: an old literal anchor and a modern slug agree.
        assert_eq!(slugify("Deep Section"), slugify("deep-section"));
    }
}
