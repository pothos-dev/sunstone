//! `sunstone-cli`: `sunstone serve` without the desktop shell. The npm package
//! (`npm/`) ships this binary so `npx sunstone ./docs` works on any machine with
//! Node — no WebKitGTK or other Tauri runtime libraries. It embeds the same
//! static SPA build the desktop embeds and hands it to
//! `sunstone_server::serve_local`, so the browser runs the same frontend as
//! `sunstone serve`.

use std::path::PathBuf;
use std::sync::Arc;

use rust_embed::RustEmbed;
use sunstone_server::serve_args::{parse_serve_args, ServeArgs, DEFAULT_SERVE_PORT};
use sunstone_server::{AppShellAssets, LocalServeOptions};

#[derive(RustEmbed)]
#[folder = "../../build/"]
// A checkout without a frontend build still type-checks; `main` refuses to
// serve an empty shell.
#[allow_missing = true]
struct AppShell;

fn main() {
    let mut args = std::env::args().skip(1).peekable();
    // `sunstone lint` checks a Bundle and exits (a folder named `lint` is `./lint`).
    if args.peek().is_some_and(|a| a == "lint") {
        args.next();
        std::process::exit(sunstone_native::lint::cli::run(args));
    }
    let opts = match parse_serve_args(args) {
        ServeArgs::Serve(opts) => opts,
        ServeArgs::Help => return print!("{}", help_string()),
        ServeArgs::Version => return println!("sunstone {}", env!("CARGO_PKG_VERSION")),
        ServeArgs::Error(msg) => {
            eprintln!("error: {msg}");
            std::process::exit(2);
        }
    };
    if AppShell::get("index.html").is_none() {
        eprintln!("error: this build has no app shell (run `bun run build` first)");
        std::process::exit(1);
    }
    let assets: AppShellAssets =
        Arc::new(|rel: &str| AppShell::get(rel).map(|f| f.data.into_owned()));
    let served = sunstone_server::serve_local(LocalServeOptions {
        bundle_root: bundle_root(opts.bundle),
        port: opts.port,
        bind: opts.bind,
        allowed_hosts: opts.allowed_hosts,
        open_browser: opts.open_browser,
        assets,
    });
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    if let Err(e) = runtime.block_on(served) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

/// `SUNSTONE_BUNDLE`, then the argument, then the current directory — the
/// desktop's `sunstone serve` precedence.
fn bundle_root(cli_path: Option<String>) -> PathBuf {
    let path = std::env::var("SUNSTONE_BUNDLE")
        .ok()
        .filter(|s| !s.is_empty())
        .or(cli_path)
        .map_or_else(|| PathBuf::from("."), PathBuf::from);
    path.canonicalize().unwrap_or(path)
}

fn help_string() -> String {
    format!(
        "\
sunstone {version}
Serve the Sunstone markdown editor to your browser at http://localhost:PORT/.

Usage:
  sunstone [BUNDLE] [--browser] [--port PORT] [--bind ADDR] [--allow-host NAME]...
  sunstone lint [BUNDLE] [--json]

Arguments:
  BUNDLE              Folder to open as a Bundle (default: current directory).
                      Edits save to disk.

Options:
  -b, --browser       Open the editor in your default browser
  -p, --port PORT     Port to listen on (default {port})
  --bind ADDR         Listen on ADDR instead of 127.0.0.1 (e.g. 0.0.0.0).
                      There is no sign-in: whoever reaches it can edit.
                      Requests must still name localhost or an --allow-host.
  --allow-host NAME   Also answer requests for host NAME, e.g. the public
                      name of a reverse proxy in front (repeatable)
  -h, --help          Print this help and exit
  -V, --version       Print version information and exit

Lint:
  Check a Bundle's Frontmatter, links, anchors, embeds and footnotes (plus OKF
  conformance when its root index.md declares okf_version) and exit non-zero
  on errors. See 'sunstone lint --help'.

The desktop app (with a native window) is at
https://github.com/pothos-dev/sunstone/releases
",
        version = env!("CARGO_PKG_VERSION"),
        port = DEFAULT_SERVE_PORT,
    )
}
