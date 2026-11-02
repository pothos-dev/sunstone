//! The `sunstone export` subcommand, shared by both binaries (the desktop's
//! `src-tauri` and the npm package's `sunstone-cli`). Hand-rolled parse, like
//! `sunstone lint` (`sunstone_native::lint::cli`).

use std::path::PathBuf;

use sunstone_native::lint::Exclude;

/// What `sunstone export …` was asked to do.
#[derive(Debug, PartialEq, Eq)]
pub enum ExportArgs {
    Export(ExportOptions),
    Help,
    Error(String),
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ExportOptions {
    /// The Bundle to export, as typed; `None` = `SUNSTONE_BUNDLE`, else the
    /// current directory.
    pub bundle: Option<String>,
    /// The folder to write (`-o` / `--out`).
    pub out: Option<String>,
    /// `--exclude` patterns (gitignore syntax), in order.
    pub exclude: Vec<String>,
}

const TRY_HELP: &str = "\n\nTry 'sunstone export --help' for usage.";

/// Parse the arguments AFTER `export`.
pub fn parse_export_args<I, S>(args: I) -> ExportArgs
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut opts = ExportOptions::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_ref() {
            "-h" | "--help" => return ExportArgs::Help,
            "-o" | "--out" => match args.next() {
                Some(p) => opts.out = Some(p.as_ref().to_string()),
                None => return ExportArgs::Error(format!("--out needs a FOLDER{TRY_HELP}")),
            },
            a if a.starts_with("--out=") => opts.out = Some(a["--out=".len()..].to_string()),
            "-x" | "--exclude" => match args.next() {
                Some(p) => opts.exclude.push(p.as_ref().to_string()),
                None => return ExportArgs::Error(format!("--exclude needs a PATTERN{TRY_HELP}")),
            },
            a if a.starts_with("--exclude=") => opts.exclude.push(a["--exclude=".len()..].to_string()),
            a if a.starts_with('-') && a != "-" => {
                return ExportArgs::Error(format!("unknown option '{a}'{TRY_HELP}"));
            }
            a if opts.bundle.is_none() => opts.bundle = Some(a.to_string()),
            a => return ExportArgs::Error(format!("unexpected extra argument '{a}'{TRY_HELP}")),
        }
    }
    if opts.out.is_none() {
        return ExportArgs::Error(format!("missing --out FOLDER{TRY_HELP}"));
    }
    ExportArgs::Export(opts)
}

pub const EXPORT_HELP: &str = "\
Export a Bundle as a folder of static HTML pages, one per Concept, with an
Explorer to browse them. Links between pages are relative, so the folder opens
straight from disk (open index.html) or from any web server.

Usage:
  sunstone export [BUNDLE] --out FOLDER [--exclude PATTERN]...

Arguments:
  BUNDLE        Folder to export (default: $SUNSTONE_BUNDLE, else the current
                directory)

Options:
  -o, --out FOLDER
                Where to write the pages. Must be new, empty, or an earlier
                export (which is replaced), and outside BUNDLE
  -x, --exclude PATTERN
                Leave matching files out; links to them read as broken.
                Gitignore syntax, relative to BUNDLE (`tickets/`, `/drafts`,
                `adr/*.md`, `**/scratch`). Repeatable
  -h, --help    Print this help and exit

Exit status: 0 on success, 1 when the export fails, 2 on a usage error.
";

/// Run `sunstone export` with the arguments after `export`; returns the exit code.
pub fn run<I, S>(args: I) -> i32
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let opts = match parse_export_args(args) {
        ExportArgs::Export(opts) => opts,
        ExportArgs::Help => {
            print!("{EXPORT_HELP}");
            return 0;
        }
        ExportArgs::Error(msg) => {
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
    let exclude = match Exclude::new(&opts.exclude) {
        Ok(exclude) => exclude,
        Err(msg) => {
            eprintln!("error: {msg}");
            return 2;
        }
    };
    let out = opts.out.expect("parse requires --out");
    match crate::export_bundle(&root, &PathBuf::from(&out), &exclude) {
        Ok(report) => {
            println!(
                "Exported {} {} and {} {} to {}; open {}",
                report.pages,
                if report.pages == 1 { "page" } else { "pages" },
                report.attachments,
                if report.attachments == 1 { "attachment" } else { "attachments" },
                out,
                PathBuf::from(&out).join("index.html").display(),
            );
            0
        }
        Err(msg) => {
            eprintln!("error: {msg}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bundle_out_and_excludes() {
        assert_eq!(
            parse_export_args(["docs", "-o", "site", "--exclude=tickets/", "-x", "drafts"]),
            ExportArgs::Export(ExportOptions {
                bundle: Some("docs".into()),
                out: Some("site".into()),
                exclude: vec!["tickets/".into(), "drafts".into()],
            })
        );
        assert_eq!(
            parse_export_args(["--out=site"]),
            ExportArgs::Export(ExportOptions { bundle: None, out: Some("site".into()), exclude: vec![] })
        );
    }

    #[test]
    fn rejects_bad_usage() {
        assert!(matches!(parse_export_args(["docs"]), ExportArgs::Error(_)));
        assert!(matches!(parse_export_args(["--out"]), ExportArgs::Error(_)));
        assert!(matches!(parse_export_args(["-o", "a", "b", "c"]), ExportArgs::Error(_)));
        assert!(matches!(parse_export_args(["-o", "a", "--force"]), ExportArgs::Error(_)));
        assert_eq!(parse_export_args(["docs", "--help"]), ExportArgs::Help);
    }
}
