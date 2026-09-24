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

/// The inside of a Markdown link's parens (`[text](inner)`), split so a
/// rewriter touches only the URL: `{leading ws}{<}{url}{>}{title}`. The URL
/// runs to the first whitespace; everything from there on is the title,
/// kept verbatim. Optional angle brackets around the URL are remembered and
/// re-applied by [`LinkInner::with_url`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkInner<'a> {
    leading: &'a str,
    angled: bool,
    /// The URL with any enclosing `<`/`>` stripped.
    pub url: &'a str,
    title: &'a str,
}

impl<'a> LinkInner<'a> {
    /// Split `inner`, or `None` when it has no URL (empty / whitespace only).
    pub fn parse(inner: &'a str) -> Option<Self> {
        let leading_ws_len = inner.len() - inner.trim_start().len();
        let leading = &inner[..leading_ws_len];
        let rest = &inner[leading_ws_len..];

        let (url_raw, title) = match rest.find(char::is_whitespace) {
            Some(p) => (&rest[..p], &rest[p..]),
            None => (rest, ""),
        };
        if url_raw.is_empty() {
            return None;
        }
        let angled = url_raw.starts_with('<') && url_raw.ends_with('>');
        let url = if angled {
            &url_raw[1..url_raw.len() - 1]
        } else {
            url_raw
        };
        Some(Self {
            leading,
            angled,
            url,
            title,
        })
    }

    /// The same inner text with the URL replaced by `url` (leading whitespace,
    /// angle brackets and title preserved).
    pub fn with_url(&self, url: &str) -> String {
        let (open, close) = if self.angled { ("<", ">") } else { ("", "") };
        format!("{}{open}{url}{close}{}", self.leading, self.title)
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
    #[test]
    fn link_inner_round_trips_every_shape() {
        use super::LinkInner;
        for inner in [
            "a.md",
            "  a.md",
            "<a b.md>",
            " <a.md> \"title\"",
            "a.md#x 'title'",
            "<a.md",
            "<>",
        ] {
            let link = LinkInner::parse(inner).unwrap();
            assert_eq!(link.with_url(link.url), inner, "{inner:?}");
        }
        let link = LinkInner::parse(" <a.md> \"t\"").unwrap();
        assert_eq!(link.url, "a.md");
        assert_eq!(link.with_url("c.md"), " <c.md> \"t\"");
        assert_eq!(LinkInner::parse("a.md \"t\"").unwrap().url, "a.md");
        // The URL stops at the first whitespace, even inside `<...>`.
        assert_eq!(LinkInner::parse("<a b.md>").unwrap().url, "<a");
        assert_eq!(LinkInner::parse(""), None);
        assert_eq!(LinkInner::parse("   "), None);
    }

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
