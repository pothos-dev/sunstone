//! `sunstone serve`: the desktop editor, in a browser, over loopback.
//!
//! One process serves both halves on one origin — the
//! [`Shape::Local`](crate::config::Shape::Local) API (the
//! ordinary [`crate::router`]) and the desktop's static SPA build, handed in by
//! the caller as [`AppShellAssets`] (the desktop binary passes the copy Tauri
//! embeds). Every path the API does not route falls through to [`app_shell`]:
//! a built file is served as-is, anything else gets `index.html` (the SPA
//! fallback), stamped with [`SERVE_MARKER`] so the frontend picks the `http`
//! backend instead of the in-memory `fake` it would use in a plain browser.
//!
//! The trust model is the desktop's — the one user is the person at the
//! machine — so the local shape drops the JWT gate. What stands in for it:
//!
//! - the listeners bind **loopback** — 127.0.0.1, plus `[::1]` where the
//!   machine has IPv6 — unless the caller names another address
//!   ([`LocalServeOptions::bind`], for a reverse proxy that cannot reach
//!   loopback);
//! - [`guard_host`] refuses any request whose `Host` (or, when present,
//!   `Origin`) is neither a loopback name nor one the caller allowed
//!   ([`LocalServeOptions::allowed_hosts`], the proxy's public name). That
//!   closes DNS rebinding — a hostile page whose domain re-resolves to
//!   127.0.0.1 is same-origin to itself but still sends its own `Host` — and
//!   cross-site form posts;
//! - the write routes take JSON bodies, so a cross-origin `fetch` needs a CORS
//!   preflight this server never answers.

use std::future::IntoFuture;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::Request,
    http::{
        header::{CACHE_CONTROL, CONTENT_TYPE, HOST, ORIGIN, X_CONTENT_TYPE_OPTIONS},
        HeaderMap, StatusCode, Uri,
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};

use crate::api_error::check_rel_path;
use crate::config::Config;

/// Resolves a built app-shell file by its forward-slash path relative to the
/// build root (`index.html`, `_app/immutable/…`), or `None` when there is no
/// such file. Only ever called with paths that passed
/// [`check_rel_path`](crate::api_error::check_rel_path): no `..`, no hidden
/// segment, not absolute.
pub type AppShellAssets = Arc<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>;

/// What `sunstone serve` was asked to serve.
pub struct LocalServeOptions {
    /// The Bundle root. Canonicalized here; must be a directory.
    pub bundle_root: PathBuf,
    /// The port to listen on. `0` picks a free one — a library-level
    /// convenience (the tests use it); the CLI insists on a real port.
    pub port: u16,
    /// The address to listen on; `None` is loopback (127.0.0.1, plus `[::1]`
    /// where available). Anything else is reachable by whoever can route to
    /// it, with no sign-in — meant for a reverse proxy on another interface.
    pub bind: Option<IpAddr>,
    /// Host names accepted in `Host` / `Origin` besides the loopback ones —
    /// the public name a reverse proxy forwards under. Lowercase, no port.
    pub allowed_hosts: Vec<String>,
    /// The desktop SPA build.
    pub assets: AppShellAssets,
}

/// Injected into every `index.html` this mode serves. `src/lib/ipc/index.ts`
/// selects the `http` backend when it finds the flag on `window`.
pub const SERVE_MARKER: &str = "<script>window.__SUNSTONE_SERVE__=true</script>";

pub(crate) async fn serve(opts: LocalServeOptions) -> Result<(), String> {
    let root = opts
        .bundle_root
        .canonicalize()
        .map_err(|e| format!("cannot open {}: {e}", opts.bundle_root.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }

    // Bind before building the index, so a taken port fails fast. The main
    // address is required; on the default loopback bind, `[::1]` on the same
    // port is best-effort (a machine without IPv6 just serves 127.0.0.1), so a
    // client resolving `localhost` to `::1` still connects.
    let addr = SocketAddr::new(opts.bind.unwrap_or(IpAddr::from([127, 0, 0, 1])), opts.port);
    let main = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!("cannot listen on {addr}: {e} (pick another port with --port)")
        } else {
            format!("cannot listen on {addr}: {e}")
        }
    })?;
    let port = main.local_addr().map(|a| a.port()).unwrap_or(opts.port);
    let v6 = match opts.bind {
        None => tokio::net::TcpListener::bind(SocketAddr::from((
            [0, 0, 0, 0, 0, 0, 0, 1],
            port,
        )))
        .await
        .ok(),
        Some(_) => None,
    };

    let (state, _watcher) = crate::start(Config::local(root.clone(), port), root.clone());
    let app = app(crate::router(state), opts.assets, opts.allowed_hosts.clone());

    match opts.bind {
        None => eprintln!("Serving {} at http://localhost:{port}/", root.display()),
        Some(ip) => {
            eprintln!("Serving {} on {}", root.display(), SocketAddr::new(ip, port));
            if !ip.is_loopback() {
                eprintln!(
                    "warning: anyone who can reach this address can read and edit the \
                     Bundle, with no sign-in"
                );
            }
        }
    }
    if !opts.allowed_hosts.is_empty() {
        eprintln!("Also answering as: {}", opts.allowed_hosts.join(", "));
    }
    eprintln!("Press Ctrl+C to stop.");
    let served = match v6 {
        Some(v6) => tokio::try_join!(
            axum::serve(main, app.clone()).into_future(),
            axum::serve(v6, app).into_future(),
        )
        .map(|_| ()),
        None => axum::serve(main, app).await,
    };
    served.map_err(|e| format!("server error: {e}"))
}

/// The API router plus the app-shell fallback, behind the host guard.
fn app(api: Router, assets: AppShellAssets, allowed_hosts: Vec<String>) -> Router {
    let allowed: Arc<[String]> = allowed_hosts.into();
    api.fallback(move |uri: Uri| {
        let assets = assets.clone();
        async move { app_shell(&assets, uri.path()) }
    })
    .layer(middleware::from_fn(move |req: Request, next: Next| {
        let allowed = allowed.clone();
        async move { guard_host(&allowed, req, next).await }
    }))
}

/// Serve a built file, or the marked `index.html` for any route the SPA owns.
fn app_shell(assets: &AppShellAssets, path: &str) -> Response {
    let rel = path.trim_start_matches('/');
    // An unrouted `/_api/…` is a client bug, not a page: no SPA fallback.
    if rel == "_api" || rel.starts_with("_api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    // The network-boundary guard every path-taking route uses (AGENTS.md):
    // no `..`, no hidden segment. (A raw backslash cannot reach here — `http`
    // refuses it in a URI, and `%5C` stays literal through to the assets.)
    if let Err(msg) = check_rel_path(rel) {
        return (StatusCode::BAD_REQUEST, msg).into_response();
    }
    if !rel.is_empty() && rel != "index.html" {
        if let Some(bytes) = assets(rel) {
            return (
                [
                    (CONTENT_TYPE, shell_content_type(rel)),
                    (X_CONTENT_TYPE_OPTIONS, "nosniff"),
                ],
                bytes,
            )
                .into_response();
        }
        // A missing *file* (it has an extension) is a 404; anything else is a
        // route the SPA resolves client-side.
        let last = rel.rsplit('/').next().unwrap_or(rel);
        if last.contains('.') {
            return StatusCode::NOT_FOUND.into_response();
        }
    }
    match assets("index.html") {
        Some(bytes) => (
            [
                (CONTENT_TYPE, "text/html; charset=utf-8"),
                (CACHE_CONTROL, "no-cache"),
            ],
            inject_marker(&String::from_utf8_lossy(&bytes)),
        )
            .into_response(),
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "this build has no app shell: run `bun run build` first",
        )
            .into_response(),
    }
}

/// `html` with [`SERVE_MARKER`] as the first child of `<head>`, so it runs
/// before any module script (prepended when there is no `<head>` tag).
fn inject_marker(html: &str) -> String {
    let at = html
        .find("<head>")
        .map(|i| i + "<head>".len())
        .or_else(|| html.find("<head ").and_then(|i| html[i..].find('>').map(|j| i + j + 1)))
        .unwrap_or(0);
    let mut out = String::with_capacity(html.len() + SERVE_MARKER.len());
    out.push_str(&html[..at]);
    out.push_str(SERVE_MARKER);
    out.push_str(&html[at..]);
    out
}

/// The `Content-Type` for an app-shell file. Deliberately separate from
/// `sunstone_native::mime` — that table serves Attachments and must never
/// answer `text/html` or JavaScript for Bundle bytes.
fn shell_content_type(rel: &str) -> &'static str {
    let ext = rel.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("wasm") => "application/wasm",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Refuse a request whose `Host` is not trusted, or whose `Origin` (sent on
/// cross-origin and on non-GET same-origin requests) names an untrusted host.
/// Trusted is loopback plus `allowed`. See the module docs for why this
/// replaces the JWT gate.
async fn guard_host(allowed: &[String], req: Request, next: Next) -> Response {
    if !headers_are_trusted(req.headers(), allowed) {
        return (
            StatusCode::FORBIDDEN,
            "sunstone serve only answers localhost (see --allow-host)",
        )
            .into_response();
    }
    next.run(req).await
}

/// Whether `Host` names a trusted host and `Origin` — absent on a same-origin
/// GET — does too. A missing `Host` fails: HTTP/1.1 requires one. `Origin` may
/// be `https://`: a TLS-terminating proxy forwards the page's own origin.
fn headers_are_trusted(headers: &HeaderMap, allowed: &[String]) -> bool {
    let trusted = |authority: &str| is_trusted_authority(authority, allowed);
    let host_ok = headers
        .get(HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(trusted);
    let origin_ok = match headers.get(ORIGIN) {
        None => true,
        Some(origin) => origin
            .to_str()
            .ok()
            .and_then(|o| o.strip_prefix("http://").or_else(|| o.strip_prefix("https://")))
            .is_some_and(trusted),
    };
    host_ok && origin_ok
}

/// Whether `authority` (`host[:port]`) names this machine's loopback or one of
/// the `allowed` host names (compared without the port, case-insensitively).
fn is_trusted_authority(authority: &str, allowed: &[String]) -> bool {
    let host = if let Some(rest) = authority.strip_prefix('[') {
        match rest.split_once(']') {
            Some((h, tail)) if tail.is_empty() || tail.starts_with(':') => h,
            _ => return false,
        }
    } else {
        authority.split(':').next().unwrap_or("")
    };
    let host = host.to_ascii_lowercase();
    matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1")
        || (!host.is_empty() && allowed.iter().any(|a| *a == host))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{seeded_bundle, server_state};
    use axum::body::Body;
    use axum::http::{Method, Request as HttpRequest};
    use tower::ServiceExt;

    fn assets() -> AppShellAssets {
        Arc::new(|rel: &str| match rel {
            "index.html" => Some(b"<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>".to_vec()),
            "_app/immutable/entry.js" => Some(b"export {}".to_vec()),
            "_app/core.wasm" => Some(b"\0asm".to_vec()),
            _ => None,
        })
    }

    /// The local-mode app over a fresh seeded Bundle, plus that Bundle's root.
    fn test_app() -> (Router, PathBuf) {
        let state = server_state(Config::local(seeded_bundle("local"), 0));
        assert_eq!(state.cfg.shape, crate::config::Shape::Local);
        let root = state.app.bundle_root.clone();
        (app(crate::router(state), assets(), vec!["notes.example.com".into()]), root)
    }

    async fn send(req: HttpRequest<Body>) -> (StatusCode, HeaderMap, String) {
        let res = test_app().0.oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (status, headers, String::from_utf8_lossy(&body).into_owned())
    }

    fn get(path: &str) -> HttpRequest<Body> {
        HttpRequest::get(path)
            .header(HOST, "localhost:3000")
            .body(Body::empty())
            .unwrap()
    }

    #[test]
    fn the_marker_lands_first_in_head() {
        assert_eq!(
            inject_marker("<html><head><title>x</title></head></html>"),
            format!("<html><head>{SERVE_MARKER}<title>x</title></head></html>")
        );
        assert_eq!(
            inject_marker("<html><head lang=\"en\"><title>x</title>"),
            format!("<html><head lang=\"en\">{SERVE_MARKER}<title>x</title>")
        );
        assert_eq!(inject_marker("<p>bare</p>"), format!("{SERVE_MARKER}<p>bare</p>"));
    }

    #[test]
    fn only_loopback_and_allowed_authorities_pass() {
        let allowed = ["notes.example.com".to_string()];
        for ok in [
            "localhost",
            "localhost:3000",
            "LOCALHOST:1",
            "127.0.0.1:3000",
            "[::1]:3000",
            "[::1]",
            "notes.example.com",
            "Notes.Example.com:443",
        ] {
            assert!(is_trusted_authority(ok, &allowed), "{ok} should pass");
        }
        assert!(!is_trusted_authority("notes.example.com", &[]), "nothing allowed by default");
        for bad in [
            "evil.example:3000",
            "localhost.evil.example",
            "127.0.0.2:3000",
            "[::1]evil",
            "0.0.0.0:3000",
            "evil.notes.example.com",
            "notes.example.com.evil",
            "",
        ] {
            assert!(!is_trusted_authority(bad, &allowed), "{bad} should be refused");
        }
    }

    #[test]
    fn app_shell_files_get_their_own_content_types() {
        assert_eq!(shell_content_type("_app/x.js"), "text/javascript; charset=utf-8");
        assert_eq!(shell_content_type("_app/x.wasm"), "application/wasm");
        assert_eq!(shell_content_type("_app/x.CSS"), "text/css; charset=utf-8");
        assert_eq!(shell_content_type("blob"), "application/octet-stream");
    }

    #[tokio::test]
    async fn the_root_and_spa_routes_serve_the_marked_index() {
        for path in ["/", "/index.html", "/some/route", "/?print=note.md&toolbar=1"] {
            let (status, headers, body) = send(get(path)).await;
            assert_eq!(status, StatusCode::OK, "{path}");
            assert_eq!(headers[CONTENT_TYPE], "text/html; charset=utf-8");
            assert!(body.contains(SERVE_MARKER), "{path} should carry the marker");
        }
    }

    #[tokio::test]
    async fn a_built_file_is_served_as_is() {
        let (status, headers, body) = send(get("/_app/immutable/entry.js")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[CONTENT_TYPE], "text/javascript; charset=utf-8");
        assert_eq!(body, "export {}");
        let (_, headers, _) = send(get("/_app/core.wasm")).await;
        assert_eq!(headers[CONTENT_TYPE], "application/wasm");
    }

    #[tokio::test]
    async fn missing_files_and_unknown_api_routes_are_404() {
        for path in ["/_app/missing.js", "/_api/nope", "/_api"] {
            let (status, _, body) = send(get(path)).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
            assert!(!body.contains(SERVE_MARKER), "{path} must not fall back to the SPA");
        }
    }

    /// The same network-boundary guard as every API route: an escape, a hidden
    /// segment (`.git/`) is a 400 before the assets are asked.
    #[tokio::test]
    async fn escaping_and_hidden_paths_are_400() {
        for path in ["/_app/../index.html", "/.git/config", "/_app/.env"] {
            let (status, _, body) = send(get(path)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{path}");
            assert!(!body.contains(SERVE_MARKER), "{path} must not fall back to the SPA");
        }
    }

    #[tokio::test]
    async fn the_api_is_served_on_the_same_origin() {
        let (status, _, body) = send(get("/_api/concept?path=note.md")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("Hello"));
    }

    #[tokio::test]
    async fn a_write_needs_no_token() {
        let req = HttpRequest::builder()
            .method(Method::PUT)
            .uri("/_api/concept")
            .header(HOST, "127.0.0.1:3000")
            .header(ORIGIN, "http://127.0.0.1:3000")
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(r##"{"path":"note.md","content":"# Edited\n"}"##))
            .unwrap();
        let (app, root) = test_app();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert_eq!(std::fs::read_to_string(root.join("note.md")).unwrap(), "# Edited\n");
    }

    #[tokio::test]
    async fn a_foreign_host_or_origin_is_refused() {
        // DNS rebinding: the page's own domain arrives as the Host.
        let rebound = HttpRequest::get("/_api/concept?path=note.md")
            .header(HOST, "evil.example:3000")
            .body(Body::empty())
            .unwrap();
        assert_eq!(send(rebound).await.0, StatusCode::FORBIDDEN);

        // A cross-site request names its origin.
        let cross = HttpRequest::get("/_api/tree")
            .header(HOST, "localhost:3000")
            .header(ORIGIN, "https://evil.example")
            .body(Body::empty())
            .unwrap();
        assert_eq!(send(cross).await.0, StatusCode::FORBIDDEN);

        let no_host = HttpRequest::get("/").body(Body::empty()).unwrap();
        assert_eq!(send(no_host).await.0, StatusCode::FORBIDDEN);

        // An allowed name does not vouch for a foreign Origin.
        let proxied_cross = HttpRequest::get("/_api/tree")
            .header(HOST, "notes.example.com")
            .header(ORIGIN, "https://evil.example")
            .body(Body::empty())
            .unwrap();
        assert_eq!(send(proxied_cross).await.0, StatusCode::FORBIDDEN);
    }

    /// Behind a TLS-terminating reverse proxy the request keeps the public
    /// name as `Host` and the page's `https://` origin.
    #[tokio::test]
    async fn an_allowed_host_passes_through_a_proxy() {
        let req = HttpRequest::builder()
            .method(Method::PUT)
            .uri("/_api/concept")
            .header(HOST, "notes.example.com")
            .header(ORIGIN, "https://notes.example.com")
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(r##"{"path":"note.md","content":"# Proxied\n"}"##))
            .unwrap();
        let (app, root) = test_app();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert_eq!(std::fs::read_to_string(root.join("note.md")).unwrap(), "# Proxied\n");
    }
}
