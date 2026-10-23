//! The `serve` command line — `[BUNDLE] [--port N] [--bind ADDR] [--allow-host
//! NAME]...` — shared by the desktop binary's `sunstone serve` subcommand and
//! the headless `sunstone-cli` binary the npm package ships. Hand-rolled (no
//! `clap`) and pure so it can be unit-tested.

use std::net::IpAddr;

/// The port `serve` listens on unless `--port` says otherwise.
pub const DEFAULT_SERVE_PORT: u16 = 3000;

/// Options for `serve`.
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

/// What a `serve` command line asks for.
#[derive(Debug, PartialEq, Eq)]
pub enum ServeArgs {
    Serve(ServeOptions),
    /// `-h`/`--help`, wherever it appears.
    Help,
    /// `-V`/`--version`, wherever it appears.
    Version,
    /// An argument error, to print to stderr before exiting non-zero.
    Error(String),
}

/// Parse `serve`'s arguments (program name and subcommand already stripped):
/// one optional positional Bundle path plus `-p`/`--port N`, `--bind ADDR` and
/// `--allow-host NAME` (each also as `--flag=VALUE`).
pub fn parse_serve_args<I, S>(args: I) -> ServeArgs
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
            "-h" | "--help" => return ServeArgs::Help,
            "-V" | "--version" => return ServeArgs::Version,
            _ => {}
        }
        let (flag, inline) = match a.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
            _ => (a, None),
        };
        if matches!(flag, "-p" | "--port" | "--bind" | "--allow-host") {
            let Some(v) = inline.or_else(|| args.next().map(|v| v.as_ref().to_string())) else {
                return ServeArgs::Error(format!("'{flag}' needs a value"));
            };
            match flag {
                "--bind" => match v.parse::<IpAddr>() {
                    Ok(ip) => opts.bind = Some(ip),
                    Err(_) => return ServeArgs::Error(format!("'{v}' is not an IP address")),
                },
                "--allow-host" => match parse_host_name(&v) {
                    Some(h) => opts.allowed_hosts.push(h),
                    None => {
                        return ServeArgs::Error(format!(
                            "'{v}' is not a host name (give it without scheme or port)"
                        ))
                    }
                },
                _ => match v.parse::<u16>() {
                    Ok(p) if p != 0 => opts.port = p,
                    _ => return ServeArgs::Error(format!("'{v}' is not a valid port")),
                },
            }
            continue;
        }
        if a.starts_with('-') && a != "-" {
            return ServeArgs::Error(format!(
                "unknown option '{a}'\n\nTry 'sunstone --help' for usage."
            ));
        }
        if opts.bundle.is_some() {
            return ServeArgs::Error(format!(
                "unexpected extra argument '{a}'\n\nTry 'sunstone --help' for usage."
            ));
        }
        opts.bundle = Some(a.to_string());
    }
    ServeArgs::Serve(opts)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn serve(bundle: Option<&str>, port: u16) -> ServeArgs {
        ServeArgs::Serve(ServeOptions {
            bundle: bundle.map(str::to_string),
            port,
            bind: None,
            allowed_hosts: Vec::new(),
        })
    }

    #[test]
    fn defaults_to_no_path_on_the_default_port() {
        assert_eq!(parse_serve_args(Vec::<String>::new()), serve(None, DEFAULT_SERVE_PORT));
    }

    #[test]
    fn takes_a_bundle_and_a_port_in_any_order() {
        assert_eq!(parse_serve_args(["./docs"]), serve(Some("./docs"), 3000));
        assert_eq!(parse_serve_args(["--port", "8080", "./docs"]), serve(Some("./docs"), 8080));
        assert_eq!(parse_serve_args(["./docs", "-p", "4000"]), serve(Some("./docs"), 4000));
        assert_eq!(parse_serve_args(["--port=5000"]), serve(None, 5000));
    }

    #[test]
    fn rejects_bad_ports_flags_and_extra_paths() {
        for args in [
            vec!["--port"],
            vec!["--port", "http"],
            vec!["--port", "0"],
            vec!["--port=70000"],
            vec!["--detached"],
            vec!["a", "b"],
            vec!["--bind"],
            vec!["--bind", "localhost"],
            vec!["--allow-host"],
            vec!["--allow-host", "https://notes.example.com"],
            vec!["--allow-host=notes.example.com:443"],
            vec!["--allow-host", "*.example.com"],
            vec!["--allow-host="],
        ] {
            assert!(
                matches!(parse_serve_args(args.clone()), ServeArgs::Error(_)),
                "{args:?} should be an error"
            );
        }
    }

    #[test]
    fn takes_a_bind_address_and_allowed_hosts() {
        let expected = ServeArgs::Serve(ServeOptions {
            bundle: Some("./docs".into()),
            port: 3001,
            bind: Some("0.0.0.0".parse().unwrap()),
            allowed_hosts: vec!["notes.example.com".into(), "wiki.lan".into()],
        });
        assert_eq!(
            parse_serve_args([
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
        match parse_serve_args(["--bind=::"]) {
            ServeArgs::Serve(o) => assert_eq!(o.bind, Some("::".parse().unwrap())),
            other => panic!("expected Serve, got {other:?}"),
        }
    }

    #[test]
    fn help_and_version_win_wherever_they_appear() {
        assert_eq!(parse_serve_args(["./docs", "--help"]), ServeArgs::Help);
        assert_eq!(parse_serve_args(["-V", "--port", "x"]), ServeArgs::Version);
    }
}
