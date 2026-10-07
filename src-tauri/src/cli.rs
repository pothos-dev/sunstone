//! Command-line argument parsing.
//!
//! Sunstone is CLI-launched (`sunstone ./docs`). The arguments are an optional
//! positional Bundle path, optionally followed by a Document inside it
//! (`sunstone ./docs guide/setup.md#install`), the conventional `--help`/`--version` flags, and
//! `--detached`/`-d` (run detached from the spawning console); or the `serve`
//! subcommand (`sunstone serve ./docs --port 3000`), which serves the editor to
//! a browser on localhost instead of opening a window. We hand-roll the
//! parse (no `clap`) to keep the dependency surface small; the grammar is tiny
//! and the logic is pure so it can be unit-tested.

use std::net::IpAddr;

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

/// The port `sunstone serve` listens on unless `--port` says otherwise.
pub const DEFAULT_SERVE_PORT: u16 = 3000;

/// Options for `sunstone serve` (the `Serve` action).
#[derive(Debug, PartialEq, Eq)]
pub struct ServeOptions {
    /// The Bundle root from the command line; `None` means `SUNSTONE_BUNDLE`,
    /// else the current directory (there is no launcher to fall back to).
    pub bundle: Option<String>,
    /// The port to listen on.
    pub port: u16,
    /// `--bind ADDR`: listen there instead of loopback.
    pub bind: Option<IpAddr>,
    /// `--allow-host NAME` (repeatable): host names to answer besides
    /// localhost, lowercased — the public name a reverse proxy forwards under.
    pub allowed_hosts: Vec<String>,
}

/// What the parsed command line tells the binary to do.
#[derive(Debug, PartialEq, Eq)]
pub enum CliAction {
    /// Launch the app with the given options.
    Run(RunOptions),
    /// Serve the editor to a browser on localhost (`sunstone serve`).
    Serve(ServeOptions),
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
/// argument, is rejected. A first argument of `serve` selects the subcommand
/// instead (see [`parse_serve_args`]); a folder literally named `serve` is
/// still reachable as `./serve`.
pub fn parse_args<I, S>(args: I) -> CliAction
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut args = args.into_iter().peekable();
    if args.peek().is_some_and(|a| a.as_ref() == "serve") {
        args.next();
        return parse_serve_args(args);
    }
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

/// `sunstone serve`'s grammar: one optional positional Bundle path plus
/// `-p`/`--port N`, `--bind ADDR` and `--allow-host NAME` (each also as
/// `--flag=VALUE`); `--help`/`--version` as for the app.
fn parse_serve_args<I, S>(args: I) -> CliAction
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut opts = ServeOptions {
        bundle: None,
        port: DEFAULT_SERVE_PORT,
        bind: None,
        allowed_hosts: Vec::new(),
    };
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let a = arg.as_ref();
        match a {
            "-h" | "--help" => return CliAction::Help,
            "-V" | "--version" => return CliAction::Version,
            _ => {}
        }
        let (flag, inline) = match a.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
            _ => (a, None),
        };
        if matches!(flag, "-p" | "--port" | "--bind" | "--allow-host") {
            let Some(v) = inline.or_else(|| args.next().map(|v| v.as_ref().to_string())) else {
                return CliAction::Error(format!("'{flag}' needs a value"));
            };
            match flag {
                "--bind" => match v.parse::<IpAddr>() {
                    Ok(ip) => opts.bind = Some(ip),
                    Err(_) => return CliAction::Error(format!("'{v}' is not an IP address")),
                },
                "--allow-host" => match parse_host_name(&v) {
                    Some(h) => opts.allowed_hosts.push(h),
                    None => {
                        return CliAction::Error(format!(
                            "'{v}' is not a host name (give it without scheme or port)"
                        ))
                    }
                },
                _ => match v.parse::<u16>() {
                    Ok(p) if p != 0 => opts.port = p,
                    _ => return CliAction::Error(format!("'{v}' is not a valid port")),
                },
            }
            continue;
        }
        if a.starts_with('-') && a != "-" {
            return CliAction::Error(format!(
                "unknown option '{a}' for serve\n\nTry 'sunstone --help' for usage."
            ));
        }
        if opts.bundle.is_some() {
            return CliAction::Error(format!(
                "unexpected extra argument '{a}'\n\nTry 'sunstone --help' for usage."
            ));
        }
        opts.bundle = Some(a.to_string());
    }
    CliAction::Serve(opts)
}

/// An `--allow-host` value, lowercased: a bare host name (`notes.example.com`),
/// no scheme, port, path or wildcard.
fn parse_host_name(v: &str) -> Option<String> {
    let ok = !v.is_empty()
        && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        && !v.starts_with(['.', '-'])
        && !v.ends_with('.');
    ok.then(|| v.to_ascii_lowercase())
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
  {name} serve [BUNDLE] [--port PORT] [--bind ADDR] [--allow-host NAME]...

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

Serve:
  Instead of opening a window, serve the editor to your browser at
  http://localhost:PORT/ (localhost only unless --bind, no sign-in). BUNDLE
  defaults to the current directory. Edits save to disk as in the app.
  -p, --port PORT     Port to listen on (default {port})
  --bind ADDR         Listen on ADDR instead of 127.0.0.1 (e.g. 0.0.0.0).
                      There is no sign-in: whoever reaches it can edit.
                      Requests must still name localhost or an --allow-host.
  --allow-host NAME   Also answer requests for host NAME, e.g. the public
                      name of a reverse proxy in front (repeatable)
",
        name = env!("CARGO_PKG_NAME"),
        version = env!("CARGO_PKG_VERSION"),
        port = DEFAULT_SERVE_PORT,
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

    fn serve(bundle: Option<&str>, port: u16) -> CliAction {
        CliAction::Serve(ServeOptions {
            bundle: bundle.map(str::to_string),
            port,
            bind: None,
            allowed_hosts: Vec::new(),
        })
    }

    #[test]
    fn serve_defaults_to_no_path_on_the_default_port() {
        assert_eq!(parse_args(["serve"]), serve(None, DEFAULT_SERVE_PORT));
    }

    #[test]
    fn serve_takes_a_bundle_and_a_port_in_any_order() {
        assert_eq!(parse_args(["serve", "./docs"]), serve(Some("./docs"), 3000));
        assert_eq!(parse_args(["serve", "--port", "8080", "./docs"]), serve(Some("./docs"), 8080));
        assert_eq!(parse_args(["serve", "./docs", "-p", "4000"]), serve(Some("./docs"), 4000));
        assert_eq!(parse_args(["serve", "--port=5000"]), serve(None, 5000));
    }

    #[test]
    fn serve_rejects_bad_ports_flags_and_extra_paths() {
        for args in [
            vec!["serve", "--port"],
            vec!["serve", "--port", "http"],
            vec!["serve", "--port", "0"],
            vec!["serve", "--port=70000"],
            vec!["serve", "--detached"],
            vec!["serve", "a", "b"],
            vec!["serve", "--bind"],
            vec!["serve", "--bind", "localhost"],
            vec!["serve", "--allow-host"],
            vec!["serve", "--allow-host", "https://notes.example.com"],
            vec!["serve", "--allow-host=notes.example.com:443"],
            vec!["serve", "--allow-host", "*.example.com"],
            vec!["serve", "--allow-host="],
        ] {
            assert!(
                matches!(parse_args(args.clone()), CliAction::Error(_)),
                "{args:?} should be an error"
            );
        }
    }

    #[test]
    fn serve_takes_a_bind_address_and_allowed_hosts() {
        let expected = CliAction::Serve(ServeOptions {
            bundle: Some("./docs".into()),
            port: 3001,
            bind: Some("0.0.0.0".parse().unwrap()),
            allowed_hosts: vec!["notes.example.com".into(), "wiki.lan".into()],
        });
        assert_eq!(
            parse_args([
                "serve",
                "./docs",
                "--bind",
                "0.0.0.0",
                "--allow-host",
                "Notes.Example.com",
                "--allow-host=wiki.lan",
                "--port=3001",
            ]),
            expected
        );
        match parse_args(["serve", "--bind=::"]) {
            CliAction::Serve(o) => assert_eq!(o.bind, Some("::".parse().unwrap())),
            other => panic!("expected Serve, got {other:?}"),
        }
    }

    #[test]
    fn serve_is_only_a_subcommand_in_first_position() {
        // `./serve` and a later `serve` are plain Bundle / Document paths.
        assert_eq!(parse_args(["./serve"]), run(Some("./serve"), false));
        assert!(matches!(parse_args(["-d", "serve"]), CliAction::Run(_)));
        assert_eq!(parse_args(["serve", "--help"]), CliAction::Help);
    }

    #[test]
    fn version_string_is_name_and_semver() {
        let v = version_string();
        assert!(v.starts_with("sunstone "));
        assert_eq!(v, format!("sunstone {}", env!("CARGO_PKG_VERSION")));
    }
}
