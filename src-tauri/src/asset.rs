//! The desktop shell's **Attachment** transport: the `sunstone-asset://` custom
//! URI scheme (ADR-0011).
//!
//! ## The URL shape (a fixed contract with the frontend)
//!
//! ```text
//! sunstone-asset://localhost/<bundle-relative path>   (Linux, macOS)
//! http://sunstone-asset.localhost/<bundle-relative path>   (Windows, wry's form)
//! ```
//!
//! The path is percent-encoded (`assets/a b.png` → `assets/a%20b.png`); we
//! decode before touching the filesystem. Both forms leave the same value in
//! `Uri::path()`, so the handler reads that and nothing else — no query, no
//! fragment, no host.
//!
//! ## Why a custom scheme and not Tauri's asset protocol
//!
//! Tauri's built-in `asset:` protocol is scoped by **static configuration**, but
//! Sunstone's Bundle root is chosen at **runtime** (`sunstone ./docs`) and the
//! [`Session`] swaps Bundles while the process lives. A runtime
//! `allow_directory` grant would have to be revoked on every swap or a closed
//! Bundle stays readable for the rest of the session. Here every request
//! resolves against `session.current()` — the **live** Bundle — so a stale grant
//! is not representable. No `protocol-asset` feature, no `fs:` capability, no
//! `assetProtocol` block in `tauri.conf.json`.
//!
//! ## Confinement
//!
//! [`bundle::resolve`] is the one confinement primitive (absolute-reject,
//! `..`-component-reject, `canonicalize`, `starts_with(root)`), shared with
//! every other read path and with `GET /api/asset` on the web shell. Anything it
//! rejects is a **403**; a path it accepts whose bytes are unreadable (missing
//! file, a directory) is a **404**.

use std::path::Path;
use std::sync::Arc;

use tauri::http::{header::CONTENT_TYPE, Request, Response, StatusCode, Uri};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use sunstone_native::{bundle, mime};

use crate::session::Session;

/// The custom URI scheme name. `sunstone-asset://localhost/<rel>` on Linux and
/// macOS; wry rewrites it to `http://sunstone-asset.localhost/<rel>` on Windows.
pub const SCHEME: &str = "sunstone-asset";

/// The bundle-relative path carried by an asset request: `Uri::path()` minus its
/// leading `/`, percent-decoded.
///
/// Decoding happens exactly once, here, and the result then goes straight into
/// [`bundle::resolve`] — so a `%2e%2e%2f`-encoded traversal is decoded *before*
/// the component check sees it, rather than sneaking past it.
fn rel_path_from_uri(uri: &Uri) -> String {
    sunstone_shared::url::percent_decode(uri.path().trim_start_matches('/'))
}

/// Resolve `rel_path` inside `root` and build the response: the bytes with a
/// `Content-Type` from [`mime::content_type_for`], a 403 for anything
/// [`bundle::resolve`] rejects as an escape, a 404 for anything unreadable.
fn serve(root: &Path, rel_path: &str) -> Response<Vec<u8>> {
    let resolved = match bundle::resolve(root, rel_path) {
        Ok(path) => path,
        Err(msg) => return error(escape_status(&msg), msg),
    };
    match std::fs::read(&resolved) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, mime::content_type_for(rel_path))
            .body(bytes)
            .expect("a static response builder cannot fail"),
        Err(e) => error(StatusCode::NOT_FOUND, format!("{rel_path}: {e}")),
    }
}

/// Classify a [`bundle::resolve`] error string. It reports an escape and a
/// failed `canonicalize` through the same `Err`, and they are different answers:
/// a refusal (403) versus a thing that is not there (404). The web shell's
/// `classify` splits the same strings, only into 400/404 — the HTTP boundary
/// there treats an escape as a malformed request rather than a refusal.
fn escape_status(msg: &str) -> StatusCode {
    if msg.contains("escapes the bundle") || msg.contains("must be bundle-relative") {
        StatusCode::FORBIDDEN
    } else {
        StatusCode::NOT_FOUND
    }
}

/// A plain-text error response. The body is for a developer reading the network
/// panel; an `<img>` only ever sees the status.
fn error(status: StatusCode, msg: String) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(msg.into_bytes())
        .expect("a static response builder cannot fail")
}

/// The asynchronous protocol handler registered on the Tauri builder.
///
/// The filesystem work runs on the blocking pool, so a large Attachment cannot
/// stall the webview's main loop. The [`Session`] is read **inside** that task,
/// so the Bundle root is the one current when the request is served.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    // Clone the Arc out of Tauri state: the handler's `State` borrow cannot
    // outlive this call, but the blocking task must.
    let session = ctx.app_handle().state::<Arc<Session>>().inner().clone();
    let rel_path = rel_path_from_uri(request.uri());

    tauri::async_runtime::spawn_blocking(move || {
        // The LIVE Bundle, per request — never a root captured at registration.
        let response = match session.current() {
            Ok(state) => serve(&state.bundle_root, &rel_path),
            // Launcher mode: no Bundle is open, so no Attachment exists.
            Err(msg) => error(StatusCode::NOT_FOUND, msg),
        };
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A throwaway canonicalized Bundle root holding one nested Attachment.
    fn temp_bundle() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sunstone-asset-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(dir.join("assets/sub")).unwrap();
        std::fs::write(dir.join("assets/sub/logo.png"), b"\x89PNG-bytes").unwrap();
        dir.canonicalize().unwrap()
    }

    fn uri(s: &str) -> Uri {
        s.parse().unwrap()
    }

    #[test]
    fn rel_path_comes_from_the_uri_path_percent_decoded() {
        assert_eq!(
            rel_path_from_uri(&uri("sunstone-asset://localhost/assets/sub/logo.png")),
            "assets/sub/logo.png"
        );
        // Percent-encoding is undone exactly once, before any resolution.
        assert_eq!(
            rel_path_from_uri(&uri("sunstone-asset://localhost/assets/a%20b%2Bc.png")),
            "assets/a b+c.png"
        );
        // Windows' rewritten form yields the same path.
        assert_eq!(
            rel_path_from_uri(&uri("http://sunstone-asset.localhost/assets/sub/logo.png")),
            "assets/sub/logo.png"
        );
    }

    #[test]
    fn a_fully_encoded_path_decodes_to_the_same_bundle_path() {
        // `tauri.ts` builds the URL with `encodeURIComponent(path)`, mirroring
        // Tauri's own `convertFileSrc`, so the separators arrive as `%2F` and the
        // whole path is ONE segment. Decoding `Uri::path()` recovers it either
        // way — this is the shape the frontend actually emits, so it is pinned.
        let root = temp_bundle();
        let rel = rel_path_from_uri(&uri("sunstone-asset://localhost/assets%2Fsub%2Flogo.png"));
        assert_eq!(rel, "assets/sub/logo.png");
        let res = serve(&root, &rel);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[CONTENT_TYPE], "image/png");
    }

    #[test]
    fn decoding_happens_exactly_once() {
        // A filename containing a LITERAL `%2F` arrives double-encoded
        // (`encodeURIComponent` turns its `%` into `%25`). One decode recovers the
        // filename; a second would turn the `%2F` into a separator and point at a
        // different file — traversal-adjacent, so it is pinned by a test.
        let root = temp_bundle();
        std::fs::write(root.join("a%2Fb.png"), b"literal-percent").unwrap();

        let rel = rel_path_from_uri(&uri("sunstone-asset://localhost/a%252Fb.png"));
        assert_eq!(rel, "a%2Fb.png");
        let res = serve(&root, &rel);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.body(), b"literal-percent");

        // And a `%` that is not an escape at all survives untouched.
        assert_eq!(
            rel_path_from_uri(&uri("sunstone-asset://localhost/50%25%20off.png")),
            "50% off.png"
        );
    }

    #[test]
    fn a_nested_attachment_is_served_with_its_content_type() {
        let root = temp_bundle();
        let res = serve(&root, "assets/sub/logo.png");
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[CONTENT_TYPE], "image/png");
        assert_eq!(res.body(), b"\x89PNG-bytes");
    }

    #[test]
    fn an_unrecognised_extension_is_served_as_opaque_bytes() {
        let root = temp_bundle();
        std::fs::write(root.join("assets/notes.bin"), b"raw").unwrap();
        let res = serve(&root, "assets/notes.bin");
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[CONTENT_TYPE], "application/octet-stream");
    }

    #[test]
    fn a_dotdot_traversal_is_forbidden() {
        let root = temp_bundle();
        assert_eq!(
            serve(&root, "../../etc/passwd").status(),
            StatusCode::FORBIDDEN
        );
        // The sneakier form: a `..` that only escapes once the prefix is walked.
        assert_eq!(
            serve(&root, "assets/../../etc/passwd").status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(serve(&root, "a/../../b").status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn an_absolute_path_is_forbidden() {
        let root = temp_bundle();
        assert_eq!(serve(&root, "/etc/passwd").status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn a_percent_encoded_traversal_is_decoded_before_it_is_checked() {
        // The decode happens in `rel_path_from_uri`, so what reaches `serve` (and
        // `bundle::resolve`'s component check) is the real `..` — the encoding
        // buys an attacker nothing.
        let root = temp_bundle();
        let rel = rel_path_from_uri(&uri("sunstone-asset://localhost/..%2F..%2Fetc%2Fpasswd"));
        assert_eq!(rel, "../../etc/passwd");
        assert_eq!(serve(&root, &rel).status(), StatusCode::FORBIDDEN);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_escaping_the_bundle_is_forbidden() {
        // The one escape the component check cannot see: every segment is normal,
        // and only `canonicalize` + `starts_with(root)` catches it. Same pattern
        // as `bundle.rs`'s `resolve_rejects_a_symlinked_escape`.
        let root = temp_bundle();
        let outside = std::env::temp_dir().join(format!(
            "sunstone-asset-outside-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.png"), b"secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape_link")).unwrap();

        assert_eq!(
            serve(&root, "escape_link/secret.png").status(),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn a_missing_attachment_is_404_not_403() {
        // The distinction matters: 404 means "ask for a different path", 403 means
        // "that path is not yours to ask for".
        let root = temp_bundle();
        assert_eq!(
            serve(&root, "assets/nope.png").status(),
            StatusCode::NOT_FOUND
        );
        // A directory resolves but has no bytes — also a 404, never a 200.
        assert_eq!(serve(&root, "assets/sub").status(), StatusCode::NOT_FOUND);
    }
}
