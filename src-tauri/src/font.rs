//! The desktop shell's transport for the user's **font files**: the
//! `sunstone-font://` custom URI scheme.
//!
//! ```text
//! sunstone-font://localhost/<file>   (the file as listed in config.json,
//!                                     percent-encoded into one segment)
//! ```
//!
//! The same shape as `sunstone-asset://` (asset.rs), but resolved against the
//! directory of the user's `config.json` instead of the Bundle, so it works in
//! launcher mode too. What may be served — only a file the config lists, only
//! a font, only inside the config dir — is decided by
//! [`appearance::font_file`], shared with `sunstone-server`'s
//! `GET /_api/appearance/font`.

use tauri::http::{header::CONTENT_TYPE, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};

use sunstone_native::appearance::{self, FontError};
use sunstone_native::config;

/// The custom URI scheme name; must match `FONT_SCHEME` in `tauri.ts`.
pub const SCHEME: &str = "sunstone-font";

/// Serve `file` from the user config dir: the bytes with a font `Content-Type`,
/// a 403 for an escape, a 404 for anything else refused or unreadable.
fn serve(file: &str) -> Response<Vec<u8>> {
    let result = match config::user_config_file() {
        Some(path) => appearance::font_file(&path, file),
        None => Err(FontError::NotFound("no OS config directory".to_string())),
    };
    let (status, content_type, body) = match result {
        Ok((bytes, content_type)) => (StatusCode::OK, content_type, bytes),
        Err(FontError::Forbidden(msg)) => (StatusCode::FORBIDDEN, "text/plain; charset=utf-8", msg.into_bytes()),
        Err(FontError::NotFound(msg)) => (StatusCode::NOT_FOUND, "text/plain; charset=utf-8", msg.into_bytes()),
    };
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, content_type)
        .header("x-content-type-options", "nosniff")
        .body(body)
        .expect("a static response builder cannot fail")
}

/// The asynchronous protocol handler registered on the Tauri builder. The file
/// read runs on the blocking pool, like `asset::handle`.
pub fn handle<R: Runtime>(
    _ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let file = sunstone_shared::url::percent_decode(request.uri().path().trim_start_matches('/'));
    tauri::async_runtime::spawn_blocking(move || responder.respond(serve(&file)));
}
