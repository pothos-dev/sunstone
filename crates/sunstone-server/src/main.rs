//! Sunstone Web's read-only HTTP server.
//!
//! A thin axum binary over `sunstone-native` — the SAME bundle/index logic the
//! Tauri desktop shell uses. It resolves a Bundle root, builds the index on
//! startup (reusing `AppState`), and serves three READ-ONLY JSON routes:
//!
//! - `GET /api/bundle-root`          → the absolute Bundle root (string)
//! - `GET /api/tree`                 → the recursive `TreeNode`
//! - `GET /api/concept?path=<rel>`   → a Concept's raw markdown (string)
//! - `GET /api/render?path=<rel>`    → rendered `{ html, frontmatter, outline }`
//! - `GET /api/search?q=<query>`     → `SearchHit[]` (bundle-wide full-text)
//! - `GET /api/backlinks?path=<rel>` → source Concept paths linking to it
//! - `GET /api/tags`                 → `TagCount[]` (tags + counts)
//! - `GET /api/concepts-by-tag?tag=` → Concept paths carrying the tag
//! - `GET /api/types`                → distinct frontmatter `type` values
//! - `GET /api/keys`                 → distinct frontmatter keys used
//! - `GET /api/concept-paths`        → every Concept path in the index
//! - `GET /api/concept-exists?path=` → whether a Concept exists (bool)
//! - `GET /api/events`               → SSE stream of filesystem `FileChange`s
//!
//! There is NO write path here. Every `path` crossing the seam is validated by
//! `sunstone-native` against the Bundle root (bundle-relative, forward-slash);
//! `..`/escape attempts are rejected with a 400 — this is now a genuine network
//! boundary, not just an in-process call.
//!
//! Live reload: the core `watcher` runs on startup with a sink that pushes each
//! `FileChange` into a `tokio::sync::broadcast` channel; every `/api/events`
//! connection subscribes and streams changes as SSE. Since the web app never
//! writes, there is nothing to suppress — every change is a genuine external
//! edit worth delivering to all connected browsers.

mod auth;
mod write;

use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::sse::{Event, KeepAlive, Sse},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};

use auth::AuthedUser;
use sunstone_native::app_state::AppState;
use sunstone_native::bundle::{self, TreeNode};
use sunstone_native::git::CommitIdentity;
use sunstone_native::index::TagCount;
use sunstone_native::render::{self, RenderPayload};
use sunstone_native::rewrite::{AnchorRename, RewriteSummary};
use sunstone_native::search::{self, SearchHit};
use sunstone_native::watcher::{self, FileAuthor, FileChange, FileOrigin};
use write::WriteResult;

/// Default HTTP port. Overridable via `SUNSTONE_API_PORT`.
const DEFAULT_PORT: u16 = 8787;

/// Capacity of the filesystem-change broadcast channel. A slow SSE consumer that
/// falls this far behind sees a lag error (skipped, not fatal).
const EVENTS_CHANNEL_CAP: usize = 256;

/// Shared server state: the domain `AppState` (bundle root + index), the
/// broadcast sender every `/api/events` connection subscribes to, the global
/// write lock serializing the write→commit critical section (ticket 05/07 §4),
/// and the HS256 secret used to verify hook-minted write JWTs (ticket 04).
pub(crate) struct ServerState {
    pub(crate) app: Arc<AppState>,
    pub(crate) events: broadcast::Sender<FileChange>,
    /// Serializes every write op's entire write → (rewrite) → commit section
    /// (one Bundle = one working tree = one shared `index.lock`).
    pub(crate) write_lock: Mutex<()>,
    /// Shared secret for verifying hook-minted write JWTs. `None` (env unset)
    /// disables writing — every write route 401s at the `AuthedUser` extractor.
    pub(crate) jwt_secret: Option<Vec<u8>>,
}

#[tokio::main]
async fn main() {
    let root = resolve_bundle_root();
    eprintln!("sunstone-server: serving bundle {}", root.display());

    // Reuse the desktop's AppState (canonical root + in-memory index built on
    // startup); the index is kept current by the watcher below.
    let app_state = Arc::new(AppState::new(root.clone()));

    // Broadcast filesystem changes to every connected SSE client. The core
    // watcher is host-agnostic: it hands us each `FileChange` through a sink;
    // our sink fans it out over the broadcast channel. No self-write
    // suppression matters here — the web server never writes.
    let (events, _) = broadcast::channel::<FileChange>(EVENTS_CHANNEL_CAP);
    let sink_tx = events.clone();
    // Kept bound (NOT dropped) for the process lifetime so watching continues.
    let _watcher = match watcher::start(root, app_state.clone(), move |change| {
        // Err only means "no subscribers right now" — fine to ignore.
        let _ = sink_tx.send(change);
    }) {
        Ok(w) => Some(watcher::WatcherHandle::new(w)),
        Err(e) => {
            eprintln!("sunstone-server: filesystem watcher failed to start: {e}");
            None
        }
    };

    // Write auth: the HS256 secret shared with the SvelteKit `/api` hook. Absent
    // → writing is disabled (every write route 401s) — a safe read-only default.
    let jwt_secret = std::env::var(auth::SECRET_ENV)
        .ok()
        .filter(|s| !s.is_empty())
        .map(String::into_bytes);
    if jwt_secret.is_none() {
        eprintln!(
            "sunstone-server: {} unset — write routes are disabled (read-only)",
            auth::SECRET_ENV
        );
    }

    let state = Arc::new(ServerState {
        app: app_state,
        events,
        write_lock: Mutex::new(()),
        jwt_secret,
    });
    let app = router(state);

    let port = std::env::var("SUNSTONE_API_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {addr}: {e}"));
    eprintln!("sunstone-server: listening on http://{addr}");
    axum::serve(listener, app).await.expect("server error");
}

/// Build the read-only route table over a `ServerState`.
fn router(state: Arc<ServerState>) -> Router {
    Router::new()
        // `/api/concept` carries the read (GET) plus the per-method write verbs
        // (ticket 07 §1): PUT overwrites, POST creates, DELETE removes (by query).
        .route(
            "/api/concept",
            get(concept_handler)
                .put(write_concept_handler)
                .post(create_concept_handler)
                .delete(delete_concept_handler),
        )
        .route("/api/folder", post(create_folder_handler))
        .route("/api/rename", post(rename_handler))
        .route("/api/move", post(move_handler))
        .route("/api/rewrite-anchors", post(rewrite_anchors_handler))
        .route("/api/bundle-root", get(bundle_root_handler))
        .route("/api/tree", get(tree_handler))
        .route("/api/render", get(render_handler))
        .route("/api/search", get(search_handler))
        .route("/api/backlinks", get(backlinks_handler))
        .route("/api/tags", get(tags_handler))
        .route("/api/concepts-by-tag", get(concepts_by_tag_handler))
        .route("/api/types", get(types_handler))
        .route("/api/keys", get(keys_handler))
        .route("/api/concept-paths", get(concept_paths_handler))
        .route("/api/concept-exists", get(concept_exists_handler))
        .route("/api/events", get(events_handler))
        .with_state(state)
}

// --- Routes -----------------------------------------------------------------

async fn bundle_root_handler(State(state): State<Arc<ServerState>>) -> Json<String> {
    Json(state.app.bundle_root.to_string_lossy().into_owned())
}

async fn tree_handler(State(state): State<Arc<ServerState>>) -> Result<Json<TreeNode>, ApiError> {
    bundle::list_tree(&state.app.bundle_root)
        .map(Json)
        .map_err(ApiError::from_core)
}

#[derive(Deserialize)]
struct ConceptQuery {
    path: String,
}

async fn concept_handler(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<ConceptQuery>,
) -> Result<Json<String>, ApiError> {
    bundle::read_concept(&state.app.bundle_root, &q.path)
        .map(Json)
        .map_err(ApiError::from_core)
}

async fn render_handler(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<ConceptQuery>,
) -> Result<Json<RenderPayload>, ApiError> {
    // Resolve links against the in-memory index. The read lock is held only for
    // the render call; a poisoned lock is a 500.
    let index = state
        .app
        .read_index()
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    render::render_concept(&state.app.bundle_root, &index, &q.path)
        .map(Json)
        .map_err(ApiError::from_core)
}

#[derive(Deserialize)]
struct SearchQuery {
    /// The search text. Defaulted so a missing/empty `?q=` yields no matches
    /// (core `search` treats an empty/whitespace query as "no scan").
    #[serde(default)]
    q: String,
}

async fn search_handler(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<SearchQuery>,
) -> Result<Json<Vec<SearchHit>>, ApiError> {
    // Case-insensitive literal search over every Concept body, ordered by path
    // then line and capped server-side (all in core `search::search`).
    search::search(&state.app.bundle_root, &q.q)
        .map(Json)
        .map_err(ApiError::from_core)
}

// --- Index-backed sidebar queries (read-only over the in-memory index) ------

#[derive(Deserialize)]
struct TagQuery {
    #[serde(default)]
    tag: String,
}

async fn backlinks_handler(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<ConceptQuery>,
) -> Result<Json<Vec<String>>, ApiError> {
    guard_rel_path(&q.path)?;
    let index = read_index(&state)?;
    Ok(Json(index.backlinks(&q.path)))
}

async fn tags_handler(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<TagCount>>, ApiError> {
    let index = read_index(&state)?;
    Ok(Json(index.all_tags()))
}

async fn concepts_by_tag_handler(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<TagQuery>,
) -> Result<Json<Vec<String>>, ApiError> {
    let index = read_index(&state)?;
    Ok(Json(index.concepts_by_tag(&q.tag)))
}

/// Distinct frontmatter `type` values across the Bundle (sorted). Feeds the
/// new-concept `type` autocomplete in the full editor shell.
async fn types_handler(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<String>>, ApiError> {
    let index = read_index(&state)?;
    Ok(Json(index.all_types()))
}

/// Distinct top-level frontmatter keys used across the Bundle (sorted). Feeds
/// the Properties panel's key-name autocomplete (OKF keys merged client-side).
async fn keys_handler(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<String>>, ApiError> {
    let index = read_index(&state)?;
    Ok(Json(index.all_keys()))
}

async fn concept_paths_handler(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<String>>, ApiError> {
    let index = read_index(&state)?;
    Ok(Json(index.concept_paths()))
}

async fn concept_exists_handler(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<ConceptQuery>,
) -> Result<Json<bool>, ApiError> {
    guard_rel_path(&q.path)?;
    let index = read_index(&state)?;
    Ok(Json(index.concept_exists(&q.path)))
}

/// Acquire the shared index read lock, mapping a poisoned lock to a 500.
fn read_index(
    state: &ServerState,
) -> Result<std::sync::RwLockReadGuard<'_, sunstone_native::index::Index>, ApiError> {
    state
        .app
        .read_index()
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e))
}

/// Reject a `path` that escapes the Bundle (absolute, or containing a `..`
/// segment) with a 400. These index routes never touch the filesystem, but the
/// path is still a client-supplied bundle-relative key, so we guard the network
/// boundary the same way the fs routes do.
fn guard_rel_path(path: &str) -> Result<(), ApiError> {
    if path.starts_with('/') || path.split('/').any(|c| c == "..") {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("path escapes the bundle: {path}"),
        ));
    }
    Ok(())
}

/// Stream filesystem changes as Server-Sent Events. Each connection subscribes
/// to the broadcast channel; changes arrive as SSE `message` events with a JSON
/// `FileChange` payload. A lagging subscriber's dropped items are skipped (not
/// fatal). Dropping the receiver on client disconnect is automatic (the stream
/// is tied to the response future). A keep-alive comment holds idle connections
/// open through proxies.
async fn events_handler(
    State(state): State<Arc<ServerState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|res| match res {
        Ok(change) => Event::default().json_data(&change).ok().map(Ok),
        // Lagged (slow consumer) — skip the missed items rather than error out.
        Err(_) => None,
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

// --- Write routes (ticket 07) -----------------------------------------------
//
// Every handler takes `AuthedUser` (proof it is gated; reads omit it) and runs
// its orchestration on a blocking thread under the global write lock. The
// identity flows into the git commit author/committer; a stamped `FileChange`
// is broadcast so other browsers live-refresh while the writer drops its echo.

#[derive(Deserialize)]
struct WriteConceptBody {
    path: String,
    content: String,
}

#[derive(Deserialize)]
struct PathBody {
    path: String,
}

#[derive(Deserialize)]
struct RenameBody {
    from: String,
    to: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveBody {
    from: String,
    to_dir: String,
}

#[derive(Deserialize)]
struct RewriteAnchorsBody {
    target: String,
    renames: Vec<AnchorRename>,
}

async fn write_concept_handler(
    State(state): State<Arc<ServerState>>,
    user: AuthedUser,
    headers: HeaderMap,
    Json(body): Json<WriteConceptBody>,
) -> Result<StatusCode, WriteError> {
    let ident = identity(&user);
    let result = run_write(&state, move |app| {
        write::write_concept(app, &ident, &body.path, &body.content)
    })
    .await?;
    broadcast_write(&state, result, &headers, &user);
    Ok(StatusCode::NO_CONTENT)
}

async fn create_concept_handler(
    State(state): State<Arc<ServerState>>,
    user: AuthedUser,
    headers: HeaderMap,
    Json(body): Json<PathBody>,
) -> Result<StatusCode, WriteError> {
    let ident = identity(&user);
    let result =
        run_write(&state, move |app| write::create_concept(app, &ident, &body.path)).await?;
    broadcast_write(&state, result, &headers, &user);
    Ok(StatusCode::NO_CONTENT)
}

async fn create_folder_handler(
    State(state): State<Arc<ServerState>>,
    user: AuthedUser,
    headers: HeaderMap,
    Json(body): Json<PathBody>,
) -> Result<StatusCode, WriteError> {
    let ident = identity(&user);
    let result =
        run_write(&state, move |app| write::create_folder(app, &ident, &body.path)).await?;
    broadcast_write(&state, result, &headers, &user);
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_concept_handler(
    State(state): State<Arc<ServerState>>,
    user: AuthedUser,
    headers: HeaderMap,
    Query(q): Query<ConceptQuery>,
) -> Result<StatusCode, WriteError> {
    let ident = identity(&user);
    let result = run_write(&state, move |app| write::delete_path(app, &ident, &q.path)).await?;
    broadcast_write(&state, result, &headers, &user);
    Ok(StatusCode::NO_CONTENT)
}

async fn rename_handler(
    State(state): State<Arc<ServerState>>,
    user: AuthedUser,
    headers: HeaderMap,
    Json(body): Json<RenameBody>,
) -> Result<Json<RewriteSummary>, WriteError> {
    let ident = identity(&user);
    let result = run_write(&state, move |app| {
        write::rename_path(app, &ident, &body.from, &body.to)
    })
    .await?;
    let summary = result.summary.unwrap_or_default();
    broadcast_write(&state, result, &headers, &user);
    Ok(Json(summary))
}

async fn move_handler(
    State(state): State<Arc<ServerState>>,
    user: AuthedUser,
    headers: HeaderMap,
    Json(body): Json<MoveBody>,
) -> Result<Json<RewriteSummary>, WriteError> {
    let ident = identity(&user);
    let result = run_write(&state, move |app| {
        write::move_path(app, &ident, &body.from, &body.to_dir)
    })
    .await?;
    let summary = result.summary.unwrap_or_default();
    broadcast_write(&state, result, &headers, &user);
    Ok(Json(summary))
}

async fn rewrite_anchors_handler(
    State(state): State<Arc<ServerState>>,
    user: AuthedUser,
    headers: HeaderMap,
    Json(body): Json<RewriteAnchorsBody>,
) -> Result<Json<RewriteSummary>, WriteError> {
    let ident = identity(&user);
    let result = run_write(&state, move |app| {
        write::rewrite_anchors(app, &ident, &body.target, &body.renames)
    })
    .await?;
    let summary = result.summary.unwrap_or_default();
    broadcast_write(&state, result, &headers, &user);
    Ok(Json(summary))
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
fn broadcast_write(
    state: &ServerState,
    result: WriteResult,
    headers: &HeaderMap,
    user: &AuthedUser,
) {
    let client_id = client_id(headers);
    for group in result.changes {
        // Err only means "no subscribers right now" — fine to ignore.
        let _ = state.events.send(FileChange {
            kind: group.kind.to_string(),
            paths: group.paths,
            origin: Some(FileOrigin {
                client_id: client_id.clone(),
                author: FileAuthor {
                    name: user.name.clone(),
                },
            }),
        });
    }
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
struct WriteError(String);

impl IntoResponse for WriteError {
    fn into_response(self) -> Response {
        (write::classify_write(&self.0), self.0).into_response()
    }
}

// --- Error mapping ----------------------------------------------------------

/// An error crossing the HTTP boundary: a status + a message. `sunstone-native`
/// returns stringly-typed errors; we classify them into 4xx codes so a path
/// escape is a `400 Bad Request` (a client mistake / attack) while a missing
/// Concept is a `404 Not Found`.
struct ApiError(StatusCode, String);

impl ApiError {
    fn from_core(msg: String) -> Self {
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
fn classify(msg: &str) -> StatusCode {
    if msg.contains("escapes the bundle") || msg.contains("must be bundle-relative") {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::NOT_FOUND
    }
}

// --- Bundle root resolution -------------------------------------------------

/// Resolve the Bundle root: `SUNSTONE_BUNDLE` if set, else the repo `examples/`
/// dir (a sensible dev default). Canonicalized so `sunstone-native`'s containment
/// check (`resolve` confirms the target stays under the canonical root) holds.
fn resolve_bundle_root() -> PathBuf {
    let explicit = std::env::var("SUNSTONE_BUNDLE")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from);
    let path = explicit.unwrap_or_else(default_dev_root);
    path.canonicalize().unwrap_or(path)
}

/// Dev fallback Bundle: the repo's `examples/` directory, relative to this
/// crate. Lets `cargo run -p sunstone-server` open a real Bundle out of the box.
fn default_dev_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

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
    fn tree_route_returns_the_bundle_tree() {
        let root = temp_bundle();
        let tree = bundle::list_tree(&root).unwrap();
        assert!(tree.is_dir);
        assert_eq!(tree.path, "");
        let children = tree.children.unwrap();
        let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
        // dirs first, then files: "sub" then "note.md".
        assert_eq!(names, vec!["sub", "note.md"]);
    }

    #[test]
    fn concept_route_reads_raw_markdown() {
        let root = temp_bundle();
        let content = bundle::read_concept(&root, "note.md").unwrap();
        assert_eq!(content, "# Hello\n\nbody");
        assert_eq!(bundle::read_concept(&root, "sub/deep.md").unwrap(), "deep");
    }

    #[test]
    fn concept_route_rejects_path_escape_with_400() {
        let root = temp_bundle();
        // A `..` escape and an absolute path both fail core validation, and the
        // server maps both to a 400 (a client / attack mistake at the boundary).
        let err = bundle::read_concept(&root, "../secret.md").unwrap_err();
        assert_eq!(classify(&err), StatusCode::BAD_REQUEST);
        let err = bundle::read_concept(&root, "/etc/passwd").unwrap_err();
        assert_eq!(classify(&err), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn router_builds_over_server_state() {
        // Smoke: constructing the router with a real ServerState (index built on
        // startup + a broadcast sender) must not panic.
        let root = temp_bundle();
        let (events, _) = broadcast::channel::<FileChange>(8);
        let _app = router(Arc::new(ServerState {
            app: Arc::new(AppState::new(root)),
            events,
            write_lock: Mutex::new(()),
            jwt_secret: None,
        }));
    }

    #[tokio::test]
    async fn broadcast_fans_a_change_out_to_every_subscriber() {
        // The SSE wiring: a change sent on the broadcast sender reaches every
        // subscribed receiver (each SSE connection is one subscriber).
        let (tx, _) = broadcast::channel::<FileChange>(8);
        let mut a = tx.subscribe();
        let mut b = tx.subscribe();
        let change = FileChange {
            kind: "modified".to_string(),
            paths: vec!["note.md".to_string()],
            origin: None,
        };
        tx.send(change).unwrap();
        let ra = a.recv().await.unwrap();
        let rb = b.recv().await.unwrap();
        assert_eq!(ra.kind, "modified");
        assert_eq!(ra.paths, vec!["note.md".to_string()]);
        assert_eq!(rb.paths, ra.paths);
    }

    #[test]
    fn render_route_returns_html_frontmatter_and_outline() {
        // A bundle with a Concept that links to a sibling that exists.
        let root = temp_bundle();
        std::fs::write(
            root.join("note.md"),
            "---\ntype: concept\n---\n# Hello\n\nSee [deep](sub/deep.md).\n",
        )
        .unwrap();
        let index = sunstone_native::index::Index::build(&root);
        let payload = render::render_concept(&root, &index, "note.md").unwrap();
        assert!(payload.html.contains("<h1 id="));
        assert!(payload.html.contains("<p>"));
        // The in-bundle link resolves to an internal nav anchor.
        assert!(payload.html.contains(r#"class="internal-link""#));
        assert!(payload.html.contains(r#"data-path="sub/deep.md""#));
        assert_eq!(payload.outline.len(), 1);
        assert_eq!(payload.outline[0].text, "Hello");
        assert_eq!(payload.frontmatter[0].key, "type");
    }

    #[test]
    fn render_route_rejects_path_escape_with_400() {
        let root = temp_bundle();
        let index = sunstone_native::index::Index::build(&root);
        let err = render::render_concept(&root, &index, "../secret.md").unwrap_err();
        assert_eq!(classify(&err), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn search_route_returns_ordered_hits() {
        let root = temp_bundle(); // note.md = "# Hello\n\nbody", sub/deep.md = "deep"
        let hits = search::search(&root, "body").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "note.md");
        assert!(hits[0].snippet.contains("body"));
    }

    #[test]
    fn search_route_empty_query_yields_no_matches() {
        let root = temp_bundle();
        assert!(search::search(&root, "").unwrap().is_empty());
        assert!(search::search(&root, "   ").unwrap().is_empty());
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
    fn index_routes_serve_backlinks_tags_and_existence() {
        let root = temp_bundle(); // has note.md + sub/deep.md
        // a.md links to note.md and carries tag `x`.
        std::fs::write(
            root.join("a.md"),
            "---\ntype: concept\ntags: [x]\n---\n[to note](/note.md)\n",
        )
        .unwrap();
        let index = sunstone_native::index::Index::build(&root);

        assert_eq!(index.backlinks("note.md"), vec!["a.md".to_string()]);
        assert!(index.all_tags().iter().any(|t| t.tag == "x" && t.count == 1));
        assert_eq!(index.concepts_by_tag("x"), vec!["a.md".to_string()]);
        assert!(index.concept_paths().contains(&"note.md".to_string()));
        assert!(index.concept_exists("note.md"));
        assert!(!index.concept_exists("nope.md"));
    }

    #[test]
    fn index_routes_serve_types_and_keys() {
        let root = temp_bundle(); // has note.md + sub/deep.md
        // Two Concepts with frontmatter: distinct `type` values + keys.
        std::fs::write(
            root.join("a.md"),
            "---\ntype: concept\ntitle: A\ntags: [x]\n---\nbody\n",
        )
        .unwrap();
        std::fs::write(
            root.join("b.md"),
            "---\ntype: index\ndescription: B\n---\nbody\n",
        )
        .unwrap();
        let index = sunstone_native::index::Index::build(&root);

        // `/api/types` → distinct, sorted frontmatter `type` values.
        assert_eq!(index.all_types(), vec!["concept", "index"]);
        // `/api/keys` → distinct, sorted top-level frontmatter keys.
        assert_eq!(
            index.all_keys(),
            vec!["description", "tags", "title", "type"]
        );
    }
}
