//! Rendering a lint [`Report`]: compiler-style text for people and editors,
//! JSON for scripts and agents.

use sunstone_shared::okf_lint::Severity;

use super::Report;

/// One `path:line: severity: message [code]` line per diagnostic, then a
/// summary. `prefix` is prepended to every bundle-relative path (the Bundle
/// argument as typed, so the locations open from the user's shell); `color`
/// adds ANSI colours.
pub fn render_text(report: &Report, prefix: &str, color: bool) -> String {
    let paint = |code: &str, s: &str| if color { format!("\x1b[{code}m{s}\x1b[0m") } else { s.to_string() };
    let mut out = String::new();
    for d in &report.diagnostics {
        let (label, code) = match d.severity {
            Severity::Error => ("error", "31"),
            Severity::Warning => ("warning", "33"),
            Severity::Info => ("info", "36"),
        };
        let location = format!("{}:{}", join(prefix, &d.path), d.line);
        out.push_str(&format!(
            "{}: {}: {} {}\n",
            paint("1", &location),
            paint(code, label),
            d.message,
            paint("2", &format!("[{}]", d.code)),
        ));
    }
    if !report.diagnostics.is_empty() {
        out.push('\n');
    }
    if report.okf_version.is_none() {
        out.push_str(&paint(
            "2",
            "note: the Bundle root's index.md declares no `okf_version`, so OKF checks were skipped\n",
        ));
    }
    let mut files = plural(report.files, "file");
    if report.excluded > 0 {
        files.push_str(&format!(" ({} excluded)", report.excluded));
    }
    if report.diagnostics.is_empty() {
        out.push_str(&paint("32", &format!("✓ {files} checked, no problems\n")));
    } else {
        let parts: Vec<String> = [(Severity::Error, "error"), (Severity::Warning, "warning"), (Severity::Info, "info")]
            .into_iter()
            .filter_map(|(s, word)| {
                let n = report.count(s);
                (n > 0).then(|| if s == Severity::Info { format!("{n} info") } else { plural(n, word) })
            })
            .collect();
        out.push_str(&format!("{} in {files}\n", parts.join(", ")));
    }
    out
}

/// The report as pretty JSON.
pub fn render_json(report: &Report) -> String {
    serde_json::to_string_pretty(report).expect("a Report always serialises") + "\n"
}

fn join(prefix: &str, path: &str) -> String {
    match prefix.trim_end_matches('/') {
        "" | "." => path.to_string(),
        p => format!("{p}/{path}"),
    }
}

fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}
