//! Command-line argument parsing.
//!
//! Sunstone is CLI-launched (`sunstone ./docs`). The arguments are an optional
//! positional Bundle path, optionally followed by a Document inside it
//! (`sunstone ./docs guide/setup.md#install`), the conventional `--help`/`--version` flags, and
//! `--detached`/`-d` (run detached from the spawning console). We hand-roll the
//! parse (no `clap`) to keep the dependency surface small; the grammar is tiny
//! and the logic is pure so it can be unit-tested.

/// Options for launching the app (the `Run` action).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RunOptions {
    /// The Bundle root from the command line; `None` means "fall back to
    /// `SUNSTONE_BUNDLE` / the per-build default" (see `resolve_bundle_root`).
    pub bundle: Option<String>,
    /// A Document to open in the Bundle, as typed (bundle-relative or relative
    /// to the working directory, optionally with a `#heading` anchor); resolved
    /// by `startup::resolve_startup_document`. Only accepted after `bundle`.
    pub document: Option<String>,
    /// Detach from the spawning console: re-spawn the UI as an independent
    /// process and return the shell prompt immediately (see `lib.rs`).
    pub detached: bool,
}

/// What the parsed command line tells the binary to do.
#[derive(Debug, PartialEq, Eq)]
pub enum CliAction {
    /// Launch the app with the given options.
    Run(RunOptions),
    /// Print version information to stdout and exit successfully.
    Version,
    /// Print usage help to stdout and exit successfully.
    Help,
    /// An argument error: print the message to stderr and exit non-zero.
    Error(String),
}

/// Parse the CLI arguments, which MUST already have the program name stripped
/// (i.e. pass `std::env::args().skip(1)`).
///
/// Grammar: up to two positionals — a Bundle path, then a Document in it — plus
/// the flags `-h`/`--help`,
/// `-V`/`--version` and `-d`/`--detached`. `--help`/`--version` take precedence
/// wherever they appear. Any unrecognised flag, or a third positional
/// argument, is rejected.
pub fn parse_args<I, S>(args: I) -> CliAction
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut opts = RunOptions::default();
    for arg in args {
        let a = arg.as_ref();
        match a {
            "-h" | "--help" => return CliAction::Help,
            "-V" | "--version" => return CliAction::Version,
            "-d" | "--detached" => opts.detached = true,
            // Anything else starting with '-' is an unknown option. A lone "-"
            // is treated as a positional (harmless; not a recognised flag).
            _ if a.starts_with('-') && a != "-" => {
                return CliAction::Error(format!(
                    "unknown option '{a}'\n\nTry 'sunstone --help' for usage."
                ));
            }
            _ if opts.bundle.is_none() => opts.bundle = Some(a.to_string()),
            _ if opts.document.is_none() => opts.document = Some(a.to_string()),
            _ => {
                return CliAction::Error(format!(
                    "unexpected extra argument '{a}'\n\nTry 'sunstone --help' for usage."
                ));
            }
        }
    }
    CliAction::Run(opts)
}

/// The `--version` line, e.g. `sunstone 0.10.0`.
pub fn version_string() -> String {
    format!("{} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"))
}

/// The `--help` text.
pub fn help_string() -> String {
    format!(
        "\
{name} {version}
A CLI-launched markdown editor with first-class Open Knowledge Format support.

Usage:
  {name} [BUNDLE [DOCUMENT[#HEADING]]]

Arguments:
  BUNDLE        Path to the folder to open as a Bundle. Omit to open the launcher
                (pick from recently-opened folders, or choose a new one).
  DOCUMENT      A markdown file in the Bundle to open, relative to the Bundle
                (e.g. guide/setup.md) or to the current directory. Append
                #HEADING to scroll to that heading.

Options:
  -d, --detached Run detached from this console (returns the prompt immediately)
  -h, --help     Print this help and exit
  -V, --version  Print version information and exit
",
        name = env!("CARGO_PKG_NAME"),
        version = env!("CARGO_PKG_VERSION"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build the expected `Run` action concisely.
    fn run(bundle: Option<&str>, detached: bool) -> CliAction {
        CliAction::Run(RunOptions {
            bundle: bundle.map(str::to_string),
            document: None,
            detached,
        })
    }

    #[test]
    fn no_args_runs_with_no_path() {
        assert_eq!(parse_args(Vec::<String>::new()), run(None, false));
    }

    #[test]
    fn positional_is_the_bundle_path() {
        assert_eq!(parse_args(["./docs"]), run(Some("./docs"), false));
    }

    #[test]
    fn detached_flags_set_detached() {
        assert_eq!(parse_args(["--detached"]), run(None, true));
        assert_eq!(parse_args(["-d"]), run(None, true));
    }

    #[test]
    fn detached_combines_with_a_path_in_any_order() {
        assert_eq!(parse_args(["-d", "./docs"]), run(Some("./docs"), true));
        assert_eq!(parse_args(["./docs", "-d"]), run(Some("./docs"), true));
    }

    #[test]
    fn version_flags_request_version() {
        assert_eq!(parse_args(["--version"]), CliAction::Version);
        assert_eq!(parse_args(["-V"]), CliAction::Version);
    }

    #[test]
    fn help_flags_request_help() {
        assert_eq!(parse_args(["--help"]), CliAction::Help);
        assert_eq!(parse_args(["-h"]), CliAction::Help);
    }

    #[test]
    fn version_takes_precedence_over_a_path() {
        assert_eq!(parse_args(["./docs", "--version"]), CliAction::Version);
    }

    #[test]
    fn unknown_flag_is_rejected() {
        match parse_args(["--nope"]) {
            CliAction::Error(msg) => assert!(msg.contains("unknown option '--nope'")),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn unknown_short_flag_is_rejected() {
        match parse_args(["-x"]) {
            CliAction::Error(msg) => assert!(msg.contains("unknown option '-x'")),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn second_positional_is_the_document() {
        let expected = CliAction::Run(RunOptions {
            bundle: Some("./docs".into()),
            document: Some("guide/setup.md#install".into()),
            detached: true,
        });
        assert_eq!(parse_args(["./docs", "guide/setup.md#install", "-d"]), expected);
        assert_eq!(parse_args(["-d", "./docs", "guide/setup.md#install"]), expected);
    }

    #[test]
    fn third_positional_is_rejected() {
        match parse_args(["./a", "b.md", "c.md"]) {
            CliAction::Error(msg) => assert!(msg.contains("unexpected extra argument 'c.md'")),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn lone_dash_is_a_positional_not_a_flag() {
        assert_eq!(parse_args(["-"]), run(Some("-"), false));
    }

    #[test]
    fn version_string_is_name_and_semver() {
        let v = version_string();
        assert!(v.starts_with("sunstone "));
        assert_eq!(v, format!("sunstone {}", env!("CARGO_PKG_VERSION")));
    }
}
