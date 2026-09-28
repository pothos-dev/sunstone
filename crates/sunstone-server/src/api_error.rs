//! Errors crossing the HTTP boundary, and the classifiers that turn
//! `sunstone-native`'s stringly-typed errors into statuses.
//!
//! Two taxonomies, one per side of the API:
//!
//! - **read** — [`ApiError`] via [`classify`]: an invalid path is `400`,
//!   everything else a `404` (the file is missing or unreadable).
//! - **write** — [`WriteError`] via [`classify_write`]: `400` / `409` / `404`,
//!   and a `500` default, since a failed write is a *server* fault.
//!
//! Both start from [`is_bad_path`], so "which core messages mean the client
//! sent an invalid path" is written down once.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// Whether an error message is a path the client should never have sent:
/// absolute, escaping the Bundle, or naming a hidden entry ([`check_rel_path`]).
fn is_bad_path(msg: &str) -> bool {
    msg.contains("escapes the bundle")
        || msg.contains("must be bundle-relative")
        || msg.contains("names a hidden entry")
}

// --- Read side --------------------------------------------------------------

/// An error crossing the HTTP boundary: a status + a message. `sunstone-native`
/// returns stringly-typed errors; we classify them into 4xx codes so a path
/// escape is a `400 Bad Request` (a client mistake / attack) while a missing
/// Concept is a `404 Not Found`.
pub(crate) struct ApiError(pub(crate) StatusCode, pub(crate) String);

impl ApiError {
    /// A core read error, classified by [`classify`].
    pub(crate) fn from_core(msg: String) -> Self {
        ApiError(classify(&msg), msg)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}

/// Map a `sunstone-native` error string to an HTTP status. Path-escape / invalid
/// path errors are the caller's fault (a real network boundary now guards
/// them) → `400`; everything else (a genuinely missing/unreadable file) → `404`.
pub(crate) fn classify(msg: &str) -> StatusCode {
    if is_bad_path(msg) {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::NOT_FOUND
    }
}

/// The network-boundary check every client-supplied bundle-relative path goes
/// through, read and write alike. Refuses:
///
/// - an escape — absolute, or containing a `..` segment;
/// - a **hidden** component — any dot-prefixed segment other than `.` itself.
///   The Bundle walker and the watcher hide these, so no Concept or Attachment
///   path ever has one; what they *do* name is `.git/` (the origin URL in
///   `.git/config`, the auth-gated history in `.git/objects`, and — writable —
///   a `core.fsmonitor` command the next `git add` would run).
///
/// `bundle::resolve` stays the filesystem-side confinement (it catches the
/// symlinked escape no string check can see); this is the syntactic half.
pub(crate) fn check_rel_path(path: &str) -> Result<(), String> {
    if path.starts_with('/') || path.split('/').any(|c| c == "..") {
        return Err(format!("path escapes the bundle: {path}"));
    }
    if path.split('/').any(|c| c.starts_with('.') && c != ".") {
        return Err(format!("path names a hidden entry: {path}"));
    }
    Ok(())
}

/// [`check_rel_path`] as a read-side `400`. The index routes never touch the
/// filesystem, but the path is still a client-supplied bundle-relative key, so
/// they guard the network boundary the same way the fs routes do.
pub(crate) fn guard_rel_path(path: &str) -> Result<(), ApiError> {
    check_rel_path(path).map_err(|msg| ApiError(StatusCode::BAD_REQUEST, msg))
}

// --- Write side -------------------------------------------------------------

/// A write failure crossing the HTTP boundary: classified by [`classify_write`]
/// (400/409/404/500 — distinct from the read classifier's 404 default). Auth
/// failures never reach here — the `AuthedUser` extractor 401s first.
pub(crate) struct WriteError(pub(crate) String);

impl IntoResponse for WriteError {
    fn into_response(self) -> Response {
        (classify_write(&self.0), self.0).into_response()
    }
}

/// Classify a write failure into an HTTP status. Distinct from the READ
/// classifier (whose default is 404): a write's default failure is a *server*
/// fault (500). Auth failures never reach here (the extractor 401s first).
pub(crate) fn classify_write(msg: &str) -> StatusCode {
    if is_bad_path(msg) || msg.contains("must end in .md") || msg.contains("must not be empty") {
        StatusCode::BAD_REQUEST // 400 — invalid path (client)
    } else if msg.contains("already exists") || msg.contains("already in that folder") {
        StatusCode::CONFLICT // 409 — create/rename onto an existing target
    } else if msg.contains("does not exist") || msg.contains("No such file") {
        StatusCode::NOT_FOUND // 404 — referenced path/parent missing
    } else {
        StatusCode::INTERNAL_SERVER_ERROR // 500 — IO / git / poisoned lock
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_escape_is_400_missing_is_404() {
        assert_eq!(classify("path escapes the bundle: ../x"), StatusCode::BAD_REQUEST);
        assert_eq!(
            classify("path must be bundle-relative: /abs"),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            classify("../x: No such file or directory"),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn guard_rel_path_rejects_escapes() {
        assert!(guard_rel_path("a/b.md").is_ok());
        assert!(guard_rel_path("note.md").is_ok());
        let escape = guard_rel_path("../secret.md").unwrap_err();
        assert_eq!(escape.0, StatusCode::BAD_REQUEST);
        assert_eq!(guard_rel_path("/etc/passwd").unwrap_err().0, StatusCode::BAD_REQUEST);
        assert_eq!(guard_rel_path("a/../../x.md").unwrap_err().0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn check_rel_path_rejects_hidden_components_but_not_dot() {
        for bad in [".git/config", "a/.git/config", ".env", "sub/.hidden.md", "..."] {
            let msg = check_rel_path(bad).unwrap_err();
            assert_eq!(classify(&msg), StatusCode::BAD_REQUEST, "{bad}");
            assert_eq!(classify_write(&msg), StatusCode::BAD_REQUEST, "{bad}");
        }
        for ok in ["", ".", "./a.md", "a/./b.md", "notes/v1.2.md", "a.b/c.md"] {
            assert!(check_rel_path(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn classify_write_maps_the_taxonomy() {
        assert_eq!(
            classify_write("path escapes the bundle: ../x"),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            classify_write("path must be bundle-relative: /abs"),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            classify_write("a Concept path must end in .md: x.txt"),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            classify_write("already exists: a.md"),
            StatusCode::CONFLICT
        );
        assert_eq!(
            classify_write("already in that folder: a.md"),
            StatusCode::CONFLICT
        );
        assert_eq!(
            classify_write("target folder does not exist: sub/x.md"),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            classify_write("git commit failed: boom"),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    /// `WriteError::into_response` carries the write taxonomy onto HTTP:
    /// 400 invalid path, 409 existing target, 404 missing referent, 500 default.
    #[test]
    fn write_error_maps_the_write_taxonomy_onto_http_statuses() {
        let status = |msg: &str| WriteError(msg.to_string()).into_response().status();
        assert_eq!(
            status("path escapes the bundle: ../x"),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(status("already exists: a.md"), StatusCode::CONFLICT);
        assert_eq!(
            status("target folder does not exist: sub"),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status("git commit failed: boom"),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
