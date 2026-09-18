//! The web shell's **Attachment** transport: `GET /api/asset?path=<rel>`
//! (ADR-0011).
//!
//! The one route in this crate that answers with raw bytes rather than
//! `Json<T>` or SSE. It is deliberately **unauthenticated**, exactly like
//! `/api/concept` and `/api/render`: an Attachment is as readable as the Concept
//! that embeds it. Only `/api/history` and `/api/file-at-rev` are gated.
//!
//! No `tower-http`/`ServeDir`. That would be a second authority on where the
//! Bundle root is, next to `state.app.bundle_root`; one hand-written handler
//! reuses the authority every other route already shares.
//!
//! ## Confinement, twice
//!
//! - [`guard_rel_path`] at the **network** boundary — the cheap syntactic check
//!   every other path-taking route runs, rejecting a leading `/` or any `..`
//!   segment with a `400` before the filesystem is touched at all.
//! - [`bundle::resolve`] at the **filesystem** — the shared primitive
//!   (absolute-reject, component-reject, `canonicalize`, `starts_with(root)`),
//!   which is what catches the escape the syntactic check *cannot* see: an
//!   in-Bundle symlink pointing outside it.
//!
//! Both, not one. `classify` then maps an escape to `400` and a path that simply
//! is not there to `404`.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{header::CONTENT_TYPE, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;

use sunstone_native::{bundle, mime};

use crate::routes_read::{classify, guard_rel_path};
use crate::{ApiError, ServerState};

#[derive(Deserialize)]
pub(crate) struct AssetQuery {
    /// The Attachment's bundle-relative, forward-slash path. axum's `Query`
    /// extractor has already percent-decoded it.
    pub(crate) path: String,
}

/// `GET /api/asset?path=<rel>` → the Attachment's bytes with a `Content-Type`
/// from [`mime::content_type_for`] (the same table the desktop's
/// `sunstone-asset://` scheme serves from, so the two shells cannot drift).
pub(crate) async fn asset_handler(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<AssetQuery>,
) -> Result<Response, ApiError> {
    guard_rel_path(&q.path)?;
    let resolved = bundle::resolve(&state.app.bundle_root, &q.path)
        .map_err(|msg| ApiError(classify(&msg), msg))?;
    // Blocking read, like every other read route in this crate — Attachments are
    // small enough that a streaming body would buy complexity, not throughput.
    let bytes = std::fs::read(&resolved)
        .map_err(|e| ApiError(StatusCode::NOT_FOUND, format!("{}: {e}", q.path)))?;
    Ok(([(CONTENT_TYPE, mime::content_type_for(&q.path))], bytes).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::sync::SyncState;
    use crate::testutil::temp_dir;
    use crate::ServerEvent;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use sunstone_native::app_state::AppState;
    use tokio::sync::broadcast;

    /// A Bundle root holding one nested Attachment, plus a Concept so the index
    /// build has something to chew on.
    fn temp_bundle() -> PathBuf {
        let root = temp_dir("asset");
        std::fs::create_dir_all(root.join("assets/sub")).unwrap();
        std::fs::write(root.join("assets/sub/logo.png"), b"\x89PNG-bytes").unwrap();
        std::fs::write(root.join("note.md"), "# Hello").unwrap();
        root
    }

    fn state_over(root: &Path) -> Arc<ServerState> {
        let (events, _) = broadcast::channel::<ServerEvent>(8);
        Arc::new(ServerState {
            app: Arc::new(AppState::new(root.to_path_buf())),
            events,
            write_lock: Mutex::new(()),
            jwt_secret: None,
            cfg: Config::plain(root.to_path_buf()),
            sync: SyncState::new(),
        })
    }

    /// Drive the handler and return `(status, content-type, body)`.
    async fn get(root: &Path, path: &str) -> (StatusCode, String, Vec<u8>) {
        let q = Query(AssetQuery {
            path: path.to_string(),
        });
        let response = match asset_handler(State(state_over(root)), q).await {
            Ok(response) => response,
            Err(e) => e.into_response(),
        };
        let status = response.status();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec();
        (status, content_type, body)
    }

    #[tokio::test]
    async fn a_nested_attachment_is_served_with_its_content_type() {
        let root = temp_bundle();
        let (status, content_type, body) = get(&root, "assets/sub/logo.png").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type, "image/png");
        assert_eq!(body, b"\x89PNG-bytes");
    }

    #[tokio::test]
    async fn the_query_value_is_decoded_exactly_once() {
        // The web contract is `?path=<percent-encoded rel>`, decoded by axum's
        // `Query` extractor. Driving the real extractor (rather than handing the
        // handler a pre-decoded struct) is what pins "once": a file whose NAME
        // contains a literal `%2F` arrives as `%252F`, and a second decode would
        // turn it into a separator pointing at a different file.
        let root = temp_bundle();
        std::fs::write(root.join("a%2Fb.png"), b"literal-percent").unwrap();

        let uri: axum::http::Uri = "/api/asset?path=a%252Fb.png".parse().unwrap();
        let q = Query::<AssetQuery>::try_from_uri(&uri).unwrap();
        assert_eq!(q.path, "a%2Fb.png");

        let response = match asset_handler(State(state_over(&root)), q).await {
            Ok(response) => response,
            Err(e) => e.into_response(),
        };
        assert_eq!(response.status(), StatusCode::OK);

        // And a nested path's `%2F` separators decode back to real separators.
        let uri: axum::http::Uri = "/api/asset?path=assets%2Fsub%2Flogo.png".parse().unwrap();
        let q = Query::<AssetQuery>::try_from_uri(&uri).unwrap();
        assert_eq!(q.path, "assets/sub/logo.png");
    }

    #[tokio::test]
    async fn an_unrecognised_extension_is_served_as_opaque_bytes() {
        let root = temp_bundle();
        std::fs::write(root.join("assets/notes.bin"), b"raw").unwrap();
        let (status, content_type, _) = get(&root, "assets/notes.bin").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type, "application/octet-stream");
    }

    #[tokio::test]
    async fn a_dotdot_traversal_is_rejected_at_the_network_boundary() {
        let root = temp_bundle();
        assert_eq!(
            get(&root, "../../etc/passwd").await.0,
            StatusCode::BAD_REQUEST
        );
        // The sneakier form: every `..` is still a `..` segment, so the cheap
        // check catches it before `bundle::resolve` is reached.
        assert_eq!(
            get(&root, "assets/../../etc/passwd").await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(get(&root, "a/../../b").await.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn an_absolute_path_is_rejected() {
        let root = temp_bundle();
        assert_eq!(get(&root, "/etc/passwd").await.0, StatusCode::BAD_REQUEST);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_symlink_escaping_the_bundle_is_rejected() {
        // The escape `guard_rel_path` cannot see — every segment is normal. Only
        // `bundle::resolve`'s `canonicalize` + `starts_with(root)` catches it,
        // which is exactly why the route guards at BOTH boundaries. Same pattern
        // as `bundle.rs`'s `resolve_rejects_a_symlinked_escape`.
        let root = temp_bundle();
        let outside = temp_dir("asset-outside");
        std::fs::write(outside.join("secret.png"), b"secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape_link")).unwrap();

        let (status, _, body) = get(&root, "escape_link/secret.png").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_ne!(body, b"secret");
    }

    #[tokio::test]
    async fn a_missing_attachment_is_404_distinct_from_an_escape() {
        let root = temp_bundle();
        assert_eq!(get(&root, "assets/nope.png").await.0, StatusCode::NOT_FOUND);
        // A directory resolves but has no bytes — a 404, never a 200.
        assert_eq!(get(&root, "assets/sub").await.0, StatusCode::NOT_FOUND);
    }
}
