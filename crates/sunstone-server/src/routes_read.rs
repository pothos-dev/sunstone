//! Read-only routes: `/api/bundle-root`, `/api/tree`, `/api/concept` (GET),
//! `/api/render`, `/api/search`, `/api/backlinks`, `/api/tags`,
//! `/api/concepts-by-tag`, `/api/types`, `/api/keys`, `/api/concept-paths`,
//! `/api/concept-exists` and `/api/events` (SSE), plus the shared `ApiError`
//! HTTP-boundary error type and its `sunstone-native` string classifier.
//!
//! Split out of `main.rs` verbatim (ticket: split main.rs) — no behavior
//! change, just relocation.

use std::convert::Infallible;
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};

use sunstone_native::bundle::{self, TreeNode};
use sunstone_native::index::TagCount;
use sunstone_native::render::{self, RenderPayload};
use sunstone_native::search::{self, SearchHit};

use crate::{ServerEvent, ServerState};

pub(crate) async fn bundle_root_handler(State(state): State<Arc<ServerState>>) -> Json<String> {
    Json(state.app.bundle_root.to_string_lossy().into_owned())
}

pub(crate) async fn tree_handler(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<TreeNode>, ApiError> {
    bundle::list_tree(&state.app.bundle_root)
        .map(Json)
        .map_err(ApiError::from_core)
}

#[derive(Deserialize)]
pub(crate) struct ConceptQuery {
    pub(crate) path: String,
}

pub(crate) async fn concept_handler(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<ConceptQuery>,
) -> Result<Json<String>, ApiError> {
    bundle::read_concept(&state.app.bundle_root, &q.path)
        .map(Json)
        .map_err(ApiError::from_core)
}

pub(crate) async fn render_handler(
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
pub(crate) struct SearchQuery {
    /// The search text. Defaulted so a missing/empty `?q=` yields no matches
    /// (core `search` treats an empty/whitespace query as "no scan").
    #[serde(default)]
    pub(crate) q: String,
}

pub(crate) async fn search_handler(
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
pub(crate) struct TagQuery {
    #[serde(default)]
    pub(crate) tag: String,
}

pub(crate) async fn backlinks_handler(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<ConceptQuery>,
) -> Result<Json<Vec<String>>, ApiError> {
    guard_rel_path(&q.path)?;
    let index = read_index(&state)?;
    Ok(Json(index.backlinks(&q.path)))
}

pub(crate) async fn tags_handler(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<TagCount>>, ApiError> {
    let index = read_index(&state)?;
    Ok(Json(index.all_tags()))
}

pub(crate) async fn concepts_by_tag_handler(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<TagQuery>,
) -> Result<Json<Vec<String>>, ApiError> {
    let index = read_index(&state)?;
    Ok(Json(index.concepts_by_tag(&q.tag)))
}

/// Distinct frontmatter `type` values across the Bundle (sorted). Feeds the
/// new-concept `type` autocomplete in the full editor shell.
pub(crate) async fn types_handler(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<String>>, ApiError> {
    let index = read_index(&state)?;
    Ok(Json(index.all_types()))
}

/// Distinct top-level frontmatter keys used across the Bundle (sorted). Feeds
/// the Properties panel's key-name autocomplete (OKF keys merged client-side).
pub(crate) async fn keys_handler(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<String>>, ApiError> {
    let index = read_index(&state)?;
    Ok(Json(index.all_keys()))
}

pub(crate) async fn concept_paths_handler(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<String>>, ApiError> {
    let index = read_index(&state)?;
    Ok(Json(index.concept_paths()))
}

pub(crate) async fn concept_exists_handler(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<ConceptQuery>,
) -> Result<Json<bool>, ApiError> {
    guard_rel_path(&q.path)?;
    let index = read_index(&state)?;
    Ok(Json(index.concept_exists(&q.path)))
}

/// Acquire the shared index read lock, mapping a poisoned lock to a 500.
pub(crate) fn read_index(
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
pub(crate) fn guard_rel_path(path: &str) -> Result<(), ApiError> {
    if path.starts_with('/') || path.split('/').any(|c| c == "..") {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("path escapes the bundle: {path}"),
        ));
    }
    Ok(())
}

/// SSE event name for a divergence notice (Spec 2 §10.3). Named, so
/// `EventSource` dispatches it **only** to `addEventListener('sync', …)`.
pub(crate) const SYNC_EVENT: &str = "sync";

/// Stream server events as Server-Sent Events. Each connection subscribes to the
/// broadcast channel; a lagging subscriber's dropped items are skipped (not
/// fatal). Dropping the receiver on client disconnect is automatic (the stream
/// is tied to the response future). A keep-alive comment holds idle connections
/// open through proxies.
///
/// Two payloads share the one connection (§10.3): a [`FileChange`] goes out
/// **unnamed** — unchanged, so it still lands in the browser's `onmessage` — and
/// a [`SyncNotice`] goes out as a named `sync` event, which no existing client
/// listens for. No second connection, no second keep-alive.
pub(crate) async fn events_handler(
    State(state): State<Arc<ServerState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|res| match res {
        // Unnamed, exactly as before — `onmessage` + `parseFileChange`.
        Ok(ServerEvent::File(change)) => Event::default().json_data(&change).ok().map(Ok),
        Ok(ServerEvent::Sync(notice)) => Event::default()
            .event(SYNC_EVENT)
            .json_data(&notice)
            .ok()
            .map(Ok),
        // Lagged (slow consumer) — skip the missed items rather than error out.
        Err(_) => None,
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

// --- Error mapping ----------------------------------------------------------

/// An error crossing the HTTP boundary: a status + a message. `sunstone-native`
/// returns stringly-typed errors; we classify them into 4xx codes so a path
/// escape is a `400 Bad Request` (a client mistake / attack) while a missing
/// Concept is a `404 Not Found`.
pub(crate) struct ApiError(pub(crate) StatusCode, pub(crate) String);

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
pub(crate) fn classify(msg: &str) -> StatusCode {
    if msg.contains("escapes the bundle") || msg.contains("must be bundle-relative") {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::NOT_FOUND
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
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

    /// §10.3 wire contract of `/api/events`: a `FileChange` goes out **unnamed**
    /// (no `event:` field, so it lands in `onmessage`), and a `SyncNotice` goes
    /// out as a **named** `sync` event (dispatched only to
    /// `addEventListener('sync', …)`), both as JSON `data:` payloads on the one
    /// connection.
    #[tokio::test]
    async fn events_route_leaves_file_unnamed_and_names_sync() {
        use crate::config::Config;
        use crate::sync::{SyncNotice, SyncNoticeKind, SyncState};
        use std::sync::{Arc, Mutex};
        use sunstone_native::app_state::AppState;
        use sunstone_native::watcher::FileChange;
        use tokio::sync::broadcast;

        let (events, _) = broadcast::channel::<ServerEvent>(8);
        let cfg = Config::plain(temp_bundle());
        let state = Arc::new(ServerState {
            app: Arc::new(AppState::new(cfg.bundle_root.clone())),
            events,
            write_lock: Mutex::new(()),
            jwt_secret: None,
            cfg,
            sync: SyncState::new(),
        });

        // Subscribe by opening the SSE response, then broadcast both payloads.
        let resp = events_handler(State(state.clone())).await.into_response();
        let mut body = resp.into_body().into_data_stream();

        macro_rules! read_frame {
            () => {{
                let chunk = tokio::time::timeout(
                    std::time::Duration::from_secs(1),
                    StreamExt::next(&mut body),
                )
                .await
                .expect("an SSE frame within 1s")
                .expect("stream still open")
                .expect("no body error");
                String::from_utf8(chunk.to_vec()).unwrap()
            }};
        }

        state
            .events
            .send(ServerEvent::File(FileChange {
                kind: "modified".to_string(),
                paths: vec!["note.md".to_string()],
                origin: None,
            }))
            .unwrap();
        let file_frame = read_frame!();
        // Unnamed: no `event:` line at all, just the JSON `data:` payload.
        assert!(
            !file_frame.lines().any(|l| l.starts_with("event:")),
            "FileChange must be unnamed, got: {file_frame}"
        );
        let data = file_frame
            .lines()
            .find_map(|l| l.strip_prefix("data:"))
            .expect("a data line")
            .trim();
        assert!(data.contains(r#""kind":"modified""#), "got: {data}");
        assert!(data.contains("note.md"), "got: {data}");

        state
            .events
            .send(ServerEvent::Sync(SyncNotice {
                kind: SyncNoticeKind::Forked,
                path: "a.md".to_string(),
                fork: Some("a (fork).md".to_string()),
            }))
            .unwrap();
        let sync_frame = read_frame!();
        // Named `sync` (the SYNC_EVENT constant is the wire name).
        let name = sync_frame
            .lines()
            .find_map(|l| l.strip_prefix("event:"))
            .expect("a named event")
            .trim();
        assert_eq!(name, SYNC_EVENT);
        let data = sync_frame
            .lines()
            .find_map(|l| l.strip_prefix("data:"))
            .expect("a data line")
            .trim();
        // camelCase kind, `fork` present for a Forked notice.
        assert!(data.contains(r#""kind":"forked""#), "got: {data}");
        assert!(data.contains(r#""fork":"a (fork).md""#), "got: {data}");
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
