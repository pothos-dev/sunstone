//! Shared "scan → sentinel → substitute" plumbing used by both the
//! CriticMarkup pass (`critic.rs`) and the citation pass (`citations.rs`).
//!
//! Both passes rewrite a delimited markup construct into a private-use-area
//! (PUA) sentinel token BEFORE comrak parses the document (so comrak treats
//! the sentinel as ordinary text, never mangling or escaping it away), then
//! substitute the sentinel for real HTML AFTER comrak has rendered — this
//! keeps `render.unsafe_` off since only OUR tags are injected as raw HTML,
//! never arbitrary document content. The two passes differ only in their PUA
//! delimiter pair and in what counts as a match; this type owns the sentinel
//! bookkeeping (id allocation, emission, and the final regex substitution) so
//! neither pass reimplements it.

use regex::Regex;

/// A `open`/`close` PUA delimiter pair plus the accumulated replacement HTML,
/// indexed by sentinel id (`\u{open}<id>\u{close}`).
pub struct Sentinels {
    open: char,
    close: char,
    repls: Vec<String>,
}

impl Sentinels {
    pub fn new(open: char, close: char) -> Self {
        Self {
            open,
            close,
            repls: Vec::new(),
        }
    }

    /// Emit a sentinel for `html` into `out`, recording the replacement under
    /// a fresh id.
    pub fn push(&mut self, out: &mut String, html: impl Into<String>) {
        let id = self.repls.len();
        self.repls.push(html.into());
        out.push(self.open);
        out.push_str(&id.to_string());
        out.push(self.close);
    }

    /// Substitute every sentinel this instance emitted (`\u{open}<id>\u{close}`)
    /// in `html` with its recorded replacement.
    pub fn substitute(&self, html: &str) -> String {
        if self.repls.is_empty() {
            return html.to_string();
        }
        let re = Regex::new(&format!("{}(\\d+){}", self.open, self.close)).unwrap();
        re.replace_all(html, |caps: &regex::Captures| {
            caps[1]
                .parse::<usize>()
                .ok()
                .and_then(|id| self.repls.get(id))
                .cloned()
                .unwrap_or_default()
        })
        .into_owned()
    }
}
