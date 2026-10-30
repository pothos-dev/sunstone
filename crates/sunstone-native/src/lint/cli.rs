//! The `sunstone lint` subcommand, shared by both binaries (the desktop's
//! `src-tauri` and the npm package's `sunstone-cli`). Hand-rolled parse, like
//! `serve` (`sunstone_server::serve_args`): the grammar is tiny.

use std::io::IsTerminal;
use std::path::PathBuf;

/// What `sunstone lint …` was asked to do.
#[derive(Debug, PartialEq, Eq)]
pub enum LintArgs {
    Lint(LintOptions),
    Help,
    Error(String),
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct LintOptions {
    /// The Bundle to check, as typed; `None` = `SUNSTONE_BUNDLE`, else the
    /// current directory.
    pub bundle: Option<String>,
    /// Print the report as JSON instead of text.
    pub json: bool,
    /// `--exclude` patterns (gitignore syntax), in order.
    pub exclude: Vec<String>,
}

/// Parse the arguments AFTER `lint`.
pub fn parse_lint_args<I, S>(args: I) -> LintArgs
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut opts = LintOptions::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_ref() {
            "-h" | "--help" => return LintArgs::Help,
            "--json" => opts.json = true,
            "-x" | "--exclude" => match args.next() {
                Some(p) => opts.exclude.push(p.as_ref().to_string()),
                None => return LintArgs::Error("--exclude needs a PATTERN\n\nTry 'sunstone lint --help' for usage.".into()),
            },
            a if a.starts_with("--exclude=") => opts.exclude.push(a["--exclude=".len()..].to_string()),
            a if a.starts_with('-') && a != "-" => {
                return LintArgs::Error(format!("unknown option '{a}'\n\nTry 'sunstone lint --help' for usage."));
            }
            a if opts.bundle.is_none() => opts.bundle = Some(a.to_string()),
            a => {
                return LintArgs::Error(format!(
                    "unexpected extra argument '{a}'\n\nTry 'sunstone lint --help' for usage."
                ));
            }
        }
    }
    LintArgs::Lint(opts)
}

pub const LINT_HELP: &str = "\
Check a Bundle's health: Frontmatter, links, anchors, embeds, footnotes and,
when the Bundle root's index.md declares okf_version, OKF conformance.

Usage:
  sunstone lint [BUNDLE] [--exclude PATTERN]... [--json]

Arguments:
  BUNDLE        Folder to check (default: $SUNSTONE_BUNDLE, else the current
                directory)

Options:
  -x, --exclude PATTERN
                Skip matching files: nothing is reported in them, but links
                into them still resolve. Gitignore syntax, relative to BUNDLE
                (`tickets/`, `/drafts`, `adr/*.md`, `**/scratch`). Repeatable
  --json        Print the report as JSON
  -h, --help    Print this help and exit

Exit status: 0 when there are no errors (warnings and info allowed), 1 when
there are errors, 2 on a usage error.
";

/// Run `sunstone lint` with the arguments after `lint`; returns the exit code.
pub fn run<I, S>(args: I) -> i32
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let opts = match parse_lint_args(args) {
        LintArgs::Lint(opts) => opts,
        LintArgs::Help => {
            print!("{LINT_HELP}");
            return 0;
        }
        LintArgs::Error(msg) => {
            eprintln!("error: {msg}");
            return 2;
        }
    };
    let shown = opts
        .bundle
        .or_else(|| std::env::var("SUNSTONE_BUNDLE").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| ".".into());
    let root = PathBuf::from(&shown);
    if !root.is_dir() {
        eprintln!("error: not a folder: {shown}");
        return 2;
    }
    let exclude = match super::Exclude::new(&opts.exclude) {
        Ok(exclude) => exclude,
        Err(msg) => {
            eprintln!("error: {msg}");
            return 2;
        }
    };
    let report = super::lint_bundle(&root, exclude);
    if opts.json {
        print!("{}", super::render_json(&report));
    } else {
        let color = std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none();
        print!("{}", super::render_text(&report, &shown, color));
    }
    i32::from(report.count(sunstone_shared::okf_lint::Severity::Error) > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bundle_and_flags() {
        assert_eq!(parse_lint_args(Vec::<String>::new()), LintArgs::Lint(LintOptions::default()));
        assert_eq!(
            parse_lint_args(["docs", "--json"]),
            LintArgs::Lint(LintOptions { bundle: Some("docs".into()), json: true, exclude: vec![] })
        );
        assert_eq!(
            parse_lint_args(["-x", "tickets/", "docs", "--exclude=adr/*.md"]),
            LintArgs::Lint(LintOptions {
                bundle: Some("docs".into()),
                json: false,
                exclude: vec!["tickets/".into(), "adr/*.md".into()],
            })
        );
        assert!(matches!(parse_lint_args(["--exclude"]), LintArgs::Error(_)));
        assert_eq!(parse_lint_args(["--help", "docs"]), LintArgs::Help);
        assert!(matches!(parse_lint_args(["--fix"]), LintArgs::Error(_)));
        assert!(matches!(parse_lint_args(["a", "b"]), LintArgs::Error(_)));
    }
}
