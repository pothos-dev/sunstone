//! Write routes (ticket 07): `/api/concept` (PUT/POST/DELETE), `/api/folder`,
//! `/api/rename`, `/api/move`, `/api/rewrite-anchors`.
//!
//! Every handler takes `AuthedUser` (proof it is gated; reads omit it) and runs
//! its orchestration on a blocking thread under the global write lock. The
//! identity flows into the git commit author/committer; a stamped `FileChange`
//! is broadcast so other browsers live-refresh while the writer drops its echo.
//!
//! All 7 handlers share one skeleton — `identity` → `write_shape` →
//! `run_write` → `broadcast_write` — differing only in which `WriteShape`
//! method they call and how they map the resulting `WriteResult` into an HTTP
//! response. [`write_and_broadcast`] captures that skeleton once; each handler
//! supplies the op closure and a `to_response` closure over `&WriteResult`.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use sunstone_native::app_state::AppState;
use sunstone_native::git::CommitIdentity;
use sunstone_native::rewrite::{AnchorRename, RewriteSummary};
use sunstone_native::watcher::{FileAuthor, FileChange, FileOrigin};

use crate::auth::AuthedUser;
use crate::routes_read::ConceptQuery;
use crate::{ServerEvent, ServerState};
use write::{WriteResult, WriteShape};

use crate::write;

#[derive(Deserialize)]
pub(crate) struct WriteConceptBody {
    path: String,
    content: String,
}

#[derive(Deserialize)]
pub(crate) struct PathBody {
    path: String,
}

#[derive(Deserialize)]
pub(crate) struct RenameBody {
    from: String,
    to: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MoveBody {
    from: String,
    to_dir: String,
}

#[derive(Deserialize)]
pub(crate) struct RewriteAnchorsBody {
    target: String,
    renames: Vec<AnchorRename>,
}

pub(crate) async fn write_concept_handler(
    State(state): State<Arc<ServerState>>,
    user: AuthedUser,
    headers: HeaderMap,
    Json(body): Json<WriteConceptBody>,
) -> Result<StatusCode, WriteError> {
    write_and_broadcast(
        &state,
        &user,
        &headers,
        move |app, shape, ident| shape.write_concept(app, ident, &body.path, &body.content),
        |_| StatusCode::NO_CONTENT,
    )
    .await
}

pub(crate) async fn create_concept_handler(
    State(state): State<Arc<ServerState>>,
    user: AuthedUser,
    headers: HeaderMap,
    Json(body): Json<PathBody>,
) -> Result<StatusCode, WriteError> {
    write_and_broadcast(
        &state,
        &user,
        &headers,
        move |app, shape, ident| shape.create_concept(app, ident, &body.path),
        |_| StatusCode::NO_CONTENT,
    )
    .await
}

pub(crate) async fn create_folder_handler(
    State(state): State<Arc<ServerState>>,
    user: AuthedUser,
    headers: HeaderMap,
    Json(body): Json<PathBody>,
) -> Result<StatusCode, WriteError> {
    write_and_broadcast(
        &state,
        &user,
        &headers,
        move |app, shape, ident| shape.create_folder(app, ident, &body.path),
        |_| StatusCode::NO_CONTENT,
    )
    .await
}

pub(crate) async fn delete_concept_handler(
    State(state): State<Arc<ServerState>>,
    user: AuthedUser,
    headers: HeaderMap,
    Query(q): Query<ConceptQuery>,
) -> Result<StatusCode, WriteError> {
    write_and_broadcast(
        &state,
        &user,
        &headers,
        move |app, shape, ident| shape.delete_path(app, ident, &q.path),
        |_| StatusCode::NO_CONTENT,
    )
    .await
}

pub(crate) async fn rename_handler(
    State(state): State<Arc<ServerState>>,
    user: AuthedUser,
    headers: HeaderMap,
    Json(body): Json<RenameBody>,
) -> Result<Json<RewriteSummary>, WriteError> {
    write_and_broadcast(
        &state,
        &user,
        &headers,
        move |app, shape, ident| shape.rename_path(app, ident, &body.from, &body.to),
        |result| Json(result.summary.unwrap_or_default()),
    )
    .await
}

pub(crate) async fn move_handler(
    State(state): State<Arc<ServerState>>,
    user: AuthedUser,
    headers: HeaderMap,
    Json(body): Json<MoveBody>,
) -> Result<Json<RewriteSummary>, WriteError> {
    write_and_broadcast(
        &state,
        &user,
        &headers,
        move |app, shape, ident| shape.move_path(app, ident, &body.from, &body.to_dir),
        |result| Json(result.summary.unwrap_or_default()),
    )
    .await
}

pub(crate) async fn rewrite_anchors_handler(
    State(state): State<Arc<ServerState>>,
    user: AuthedUser,
    headers: HeaderMap,
    Json(body): Json<RewriteAnchorsBody>,
) -> Result<Json<RewriteSummary>, WriteError> {
    write_and_broadcast(
        &state,
        &user,
        &headers,
        move |app, shape, ident| shape.rewrite_anchors(app, ident, &body.target, &body.renames),
        |result| Json(result.summary.unwrap_or_default()),
    )
    .await
}

/// The shared write-handler skeleton (identity → shape → run_write →
/// broadcast_write), parameterized by the per-handler op and response mapping.
///
/// `op` runs on the blocking thread inside `run_write`'s write-lock section; it
/// receives the resolved `WriteShape` and `CommitIdentity` so it can call the
/// one `WriteShape` method the handler cares about. `to_response` runs back on
/// the async task, over a `&WriteResult`, so a handler that needs the rewrite
/// summary can read it before `broadcast_write` consumes the result's change
/// groups.
async fn write_and_broadcast<F, R>(
    state: &Arc<ServerState>,
    user: &AuthedUser,
    headers: &HeaderMap,
    op: F,
    to_response: impl FnOnce(&WriteResult) -> R,
) -> Result<R, WriteError>
where
    F: FnOnce(&AppState, WriteShape, &CommitIdentity) -> Result<WriteResult, String>
        + Send
        + 'static,
{
    let ident = identity(user);
    let shape = write_shape(state);
    let result = run_write(state, move |app| op(app, shape, &ident)).await?;
    let response = to_response(&result);
    broadcast_write(state, result, headers, user);
    Ok(response)
}

/// §5's write-path gate, read off the one parse of the environment — never off
/// the environment itself and never by sniffing the filesystem for a `.git`.
///
/// Taken **before** `run_write`, because the closure it hands to the blocking
/// task sees only an `&AppState`; `WriteShape` is `Copy`, so the closure captures
/// the decision rather than the whole `ServerState`.
fn write_shape(state: &Arc<ServerState>) -> WriteShape {
    WriteShape::for_config(&state.cfg)
}

/// The commit identity for the authenticated user (author == committer).
fn identity(user: &AuthedUser) -> CommitIdentity {
    CommitIdentity {
        name: user.name.clone(),
        email: user.email.clone(),
    }
}

/// Run a write op on a blocking thread while holding the global write lock, so
/// the whole write → (rewrite) → commit section is serialized. Maps the join
/// error and the op's `String` error into a `WriteError`.
async fn run_write<F>(state: &Arc<ServerState>, op: F) -> Result<WriteResult, WriteError>
where
    F: FnOnce(&AppState) -> Result<WriteResult, String> + Send + 'static,
{
    let state = state.clone();
    let joined = tokio::task::spawn_blocking(move || -> Result<WriteResult, String> {
        let _guard = state
            .write_lock
            .lock()
            .map_err(|_| "write lock poisoned".to_string())?;
        op(&state.app)
    })
    .await;
    match joined {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(msg)) => Err(WriteError(msg)),
        Err(join) => Err(WriteError(format!("write task failed: {join}"))),
    }
}

/// Broadcast each change group stamped with the write's `origin` (the forwarded
/// per-tab `clientId` + the OIDC author name), so other browsers live-refresh
/// and the writer's own tab drops its echo (ticket 08 §1).
pub(crate) fn broadcast_write(
    state: &ServerState,
    result: WriteResult,
    headers: &HeaderMap,
    user: &AuthedUser,
) {
    let client_id = client_id(headers);
    for group in result.changes {
        // Err only means "no subscribers right now" — fine to ignore.
        let _ = state.events.send(ServerEvent::File(FileChange {
            kind: group.kind.to_string(),
            paths: group.paths,
            origin: Some(FileOrigin {
                client_id: client_id.clone(),
                author: FileAuthor {
                    name: user.name.clone(),
                },
            }),
        }));
    }
    // §5 — kick the loop, unconditionally. The write lock is released by the time
    // we get here (`run_write` dropped its guard when it returned), so the loop's
    // first act on waking is to acquire a free one; outbound latency is therefore
    // independent of the poll interval (§8.1). Only meaningful in the git-synced
    // shape — a kick with no loop running is a no-op.
    state.sync.kick();
}

/// The originating tab's client id, forwarded by the client on the write (empty
/// when absent — then no browser matches it and every tab treats it as genuine).
fn client_id(headers: &HeaderMap) -> String {
    headers
        .get("x-sunstone-client")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

/// A write failure crossing the HTTP boundary: classified by `classify_write`
/// (400/409/404/500 — distinct from the read classifier's 404 default). Auth
/// failures never reach here — the `AuthedUser` extractor 401s first.
pub(crate) struct WriteError(String);

impl IntoResponse for WriteError {
    fn into_response(self) -> Response {
        (write::classify_write(&self.0), self.0).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{self, Config};
    use crate::sync::SyncState;
    use sunstone_native::app_state::AppState;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;
    use tokio::sync::broadcast;

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A throwaway canonicalized bundle root under the OS temp dir, seeded with
    /// one Concept so the happy-path routes have something to read.
    fn temp_bundle() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "sunstone-server-{}-{}",
            std::process::id(),
            n
        ));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("note.md"), "# Hello\n\nbody").unwrap();
        std::fs::write(dir.join("sub/deep.md"), "deep").unwrap();
        dir.canonicalize().unwrap()
    }

    /// A `ServerState` over `cfg`, with nothing running behind it — enough to
    /// exercise the wiring the handlers do before/after `run_write`.
    fn state_with(cfg: Config) -> Arc<ServerState> {
        let (events, _) = broadcast::channel::<ServerEvent>(8);
        Arc::new(ServerState {
            app: Arc::new(AppState::new(cfg.bundle_root.clone())),
            events,
            write_lock: Mutex::new(()),
            jwt_secret: None,
            cfg,
            sync: SyncState::new(),
        })
    }

    /// §5's gate really reaches the handlers: every write closure names the shape
    /// derived from the parsed config, so a plain-shape Save writes the file and
    /// runs no git (rather than 500ing on `git::commit` in a non-repo bundle).
    #[test]
    fn write_handlers_take_their_shape_from_the_parsed_config() {
        let root = temp_bundle();
        assert_eq!(
            write_shape(&state_with(Config::plain(root.clone()))),
            WriteShape::Plain
        );
        let mut git_cfg = Config::plain(root.clone());
        git_cfg.shape = config::Shape::GitLocal;
        assert_eq!(write_shape(&state_with(git_cfg)), WriteShape::Git);
        let mut synced = Config::plain(root);
        synced.shape = config::Shape::GitSynced;
        assert_eq!(write_shape(&state_with(synced)), WriteShape::Git);
    }

    /// §5's kick: the write path signals the loop once the write lock is free
    /// (`broadcast_write` runs after `run_write` returned, so it is), which is
    /// what makes outbound latency independent of the poll interval.
    #[tokio::test]
    async fn a_write_kicks_the_sync_loop_after_broadcasting() {
        let state = state_with(Config::plain(temp_bundle()));
        let user = AuthedUser {
            name: "Ada Lovelace".to_string(),
            email: "ada@example.com".to_string(),
        };
        let result = WriteResult {
            changes: vec![write::ChangeGroup {
                kind: "modified",
                paths: vec!["note.md".to_string()],
            }],
            summary: None,
        };
        let mut events = state.events.subscribe();

        broadcast_write(&state, result, &HeaderMap::new(), &user);

        // The stamped change went out…
        let ServerEvent::File(change) = events.recv().await.unwrap() else {
            panic!("expected a File event");
        };
        assert_eq!(change.paths, vec!["note.md".to_string()]);
        // …and the loop was kicked: the permit is already stored, so a loop
        // waiting on the `Notify` wakes immediately rather than after an interval.
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            state.sync.notify.notified(),
        )
        .await
        .expect("the write left a wake-up permit for the loop");
    }

    /// Ticket 08 §1: a rename broadcasts exactly two change groups — `removed`
    /// (old path) then `modified` (new path) — each stamped with the forwarded
    /// `x-sunstone-client` id and the OIDC author name, so the writing tab drops
    /// its echo and every other tab live-refreshes.
    #[tokio::test]
    async fn rename_broadcasts_removed_then_modified_with_the_forwarded_client_id() {
        let state = state_with(Config::plain(temp_bundle()));
        let user = AuthedUser {
            name: "Ada Lovelace".to_string(),
            email: "ada@example.com".to_string(),
        };
        let mut headers = HeaderMap::new();
        headers.insert("x-sunstone-client", "tab-42".parse().unwrap());
        let mut events = state.events.subscribe();

        let result = rename_handler(
            State(state.clone()),
            user,
            headers,
            Json(RenameBody {
                from: "note.md".to_string(),
                to: "renamed.md".to_string(),
            }),
        )
        .await;
        if let Err(e) = result {
            panic!("plain-shape rename failed: {}", e.0);
        }

        let ServerEvent::File(first) = events.recv().await.unwrap() else {
            panic!("expected a File event");
        };
        assert_eq!(first.kind, "removed");
        assert_eq!(first.paths, vec!["note.md".to_string()]);
        let origin = first.origin.expect("the write stamps its origin");
        assert_eq!(origin.client_id, "tab-42");
        assert_eq!(origin.author.name, "Ada Lovelace");

        let ServerEvent::File(second) = events.recv().await.unwrap() else {
            panic!("expected a File event");
        };
        assert_eq!(second.kind, "modified");
        assert!(second.paths.contains(&"renamed.md".to_string()));
        let origin = second.origin.expect("the write stamps its origin");
        assert_eq!(origin.client_id, "tab-42");
        assert_eq!(origin.author.name, "Ada Lovelace");

        // Exactly two groups — nothing else was broadcast.
        assert!(events.try_recv().is_err());
    }

    /// A missing/absent `x-sunstone-client` header stamps an empty client id,
    /// so no browser matches it and every tab treats the change as genuine.
    #[test]
    fn a_missing_client_header_yields_an_empty_client_id() {
        assert_eq!(client_id(&HeaderMap::new()), "");
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
