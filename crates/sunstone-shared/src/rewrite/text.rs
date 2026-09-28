//! The pure link-inner helper ([`LinkInner`]) for link rewriting, shared by the
//! anchor rewriter (`anchors`) and the move/rename engine (`moves`). The
//! engine's path math (`relative_path`, `shortest_resolving_suffix`) lives in
//! `relpath`; the URL `split_suffix` in `crate::paths`.

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
}
