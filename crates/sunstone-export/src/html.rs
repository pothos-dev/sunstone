//! HTML text escaping for the export's own markup (the rendered body arrives
//! already escaped from `sunstone_native::render`).

/// Escape `s` for HTML text and double-quoted attribute values.
pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Undo [`escape`] (and the renderer's identical attribute escaping).
pub fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_round_trips() {
        let s = r#"a <b> & "c" &amp;"#;
        assert_eq!(escape(s), "a &lt;b&gt; &amp; &quot;c&quot; &amp;amp;");
        assert_eq!(unescape(&escape(s)), s);
    }
}
