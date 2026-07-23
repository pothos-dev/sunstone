//! Pure URL / UTF-8 helpers for link rewriting (the wasm-safe subset of the
//! former `sunstone-native::rewrite::paths`). The move/rename engine's
//! path-math (`basename_of`, `relative_path`, `shortest_resolving_suffix`)
//! stays native; only what the shared anchor rewriter needs lives here.

/// Split a URL into its path part and the `#anchor`/`?query` suffix (preserved
/// verbatim, including the leading `#` or `?`). The suffix begins at the first
/// `#` or `?`, whichever comes first.
pub fn split_suffix(url: &str) -> (&str, &str) {
    let hash = url.find('#');
    let query = url.find('?');
    let cut = match (hash, query) {
        (Some(h), Some(q)) => Some(h.min(q)),
        (Some(h), None) => Some(h),
        (None, Some(q)) => Some(q),
        (None, None) => None,
    };
    match cut {
        Some(c) => (&url[..c], &url[c..]),
        None => (url, ""),
    }
}

/// Byte length of a UTF-8 code point from its leading byte.
pub fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else if b >> 3 == 0b11110 {
        4
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_suffix_splits_at_first_anchor_or_query() {
        assert_eq!(split_suffix("a.md"), ("a.md", ""));
        assert_eq!(split_suffix("a.md#h"), ("a.md", "#h"));
        assert_eq!(split_suffix("a.md?q=1"), ("a.md", "?q=1"));
        // Whichever indicator comes first wins; the rest is kept verbatim.
        assert_eq!(split_suffix("a.md#h?q"), ("a.md", "#h?q"));
        assert_eq!(split_suffix("a.md?q=1#h"), ("a.md", "?q=1#h"));
    }

    #[test]
    fn utf8_len_reads_the_leading_byte() {
        assert_eq!(utf8_len(b'a'), 1); // ASCII
        assert_eq!(utf8_len(0xC3), 2); // 2-byte lead (é)
        assert_eq!(utf8_len(0xE2), 3); // 3-byte lead (€)
        assert_eq!(utf8_len(0xF0), 4); // 4-byte lead (emoji)
        assert_eq!(utf8_len(0x80), 1); // continuation byte -> treated as 1
        assert_eq!(utf8_len(0xFF), 1); // invalid lead -> treated as 1
    }
}
