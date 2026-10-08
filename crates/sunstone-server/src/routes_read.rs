//! Read-only routes: `/_api/bundle-root`, `/_api/tree`, `/_api/concept` (GET),
//! `/_api/render`, `/_api/search`, `/_api/backlinks`, `/_api/tags`,
//! `/_api/concepts-by-tag`, `/_api/types`, `/_api/keys`, `/_api/concept-paths`,
//! `/_api/attachment-paths`, `/_api/events` (SSE) and `/_api/version`, plus the shared
//! [`read_index`] helper. Errors map through [`crate::api_error`].

use std::convert::Infallible;
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};

use sunstone_native::bundle::{self, TreeNode};
use sunstone_native::index::TagCount;
use sunstone_native::render::{self, RenderPayload};
use sunstone_native::search::{self, SearchHit};
use sunstone_shared::url::query_encode;

use crate::api_error::{guard_rel_path, ApiError};
use crate::{ServerEvent, ServerState};

/// Which build is running: the release version, and the git commit when the
/// image build passed one (`SUNSTONE_COMMIT` build arg, see the Dockerfile).
#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct VersionInfo {
    version: &'static str,
    commit: Option<&'static str>,
}

/// `GET /_api/version`. Unauthenticated and content-free, like `/_api/sync-status`.
pub(crate) async fn version_handler() -> Json<VersionInfo> {
    Json(VersionInfo {
        version: env!("CARGO_PKG_VERSION"),
        commit: option_env!("SUNSTONE_COMMIT").filter(|c| !c.is_empty()),
    })
}

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
    guard_rel_path(&q.path)?;
    bundle::read_concept(&state.app.bundle_root, &q.path)
        .map(Json)
        .map_err(ApiError::from_core)
}

pub(crate) async fn render_handler(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<ConceptQuery>,
) -> Result<Json<RenderPayload>, ApiError> {
    guard_rel_path(&q.path)?;
    // Resolve links against the in-memory index. The read lock is held only for
    // the render call; a poisoned lock is a 500.
    let index = read_index(&state)?;
    render::render_concept(&state.app.bundle_root, &index, &q.path, &asset_url)
        .map(Json)
        .map_err(ApiError::from_core)
}

/// The web shell's Attachment-URL mapper, handed to the shared renderer so an
/// Embed's `src` is fetchable from the SSR'd page (af-1, ADR-0011).
///
/// The shape is `routes_asset.rs`'s — `/_api/asset?path=<percent-encoded>` — and
/// must stay identical to `http.ts`'s `attachmentUrl`. Relative and same-origin,
/// so it rides the `src/hooks.server.ts` proxy and needs no CORS.
///
/// This is why the renderer takes a MAPPER and not the asset-URL *prefix*
/// ADR-0011 first proposed: a query value and the desktop's single
/// percent-encoded path segment are not two prefixes over the same string.
fn asset_url(path: &str) -> String {
    format!("/_api/asset?path={}", query_encode(path))
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

/// Every **Attachment** path in the Bundle index (af-1), sorted. Deliberately a
/// SEPARATE route from `/_api/concept-paths` rather than a flag on it, mirroring
/// the two separate corpora in the index: the concept list stays `.md`-only for
/// the tree / Quick nav / Wikilink consumers, and this one is the Embed
/// resolver's candidate set.
///
/// Unauthenticated, exactly like `/_api/concept-paths` and `/_api/asset`: it is a
/// list of file names in a Bundle whose bytes are already served unauthenticated.
pub(crate) async fn attachment_paths_handler(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<String>>, ApiError> {
    let index = read_index(&state)?;
    Ok(Json(index.attachment_paths()))
}

/// Every `index.md` declaring `okf_version` (OKF v0.2 §12): the marker input
/// the frontend's wasm `BundleIndex` finds the Bundle root from, beside
/// `/_api/concept-paths`. Takes no path, so there is nothing to guard; and it is
/// unauthenticated like the concept list, since those files are served too.
pub(crate) async fn okf_markers_handler(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<sunstone_shared::OkfMarker>>, ApiError> {
    let index = read_index(&state)?;
    Ok(Json(index.okf_markers()))
}

/// The served Bundle's path within its git repository (`""` = the Bundle is the
/// toplevel), `null` outside one: the git-toplevel rung's input to the
/// frontend's Bundle-root ladder, beside `/_api/okf-markers`. Takes no path, so
/// there is nothing to guard; it names no more than the served URLs already do.
pub(crate) async fn git_prefix_handler(
    State(state): State<Arc<ServerState>>,
) -> Json<Option<String>> {
    Json(state.app.git_prefix())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_error::classify;
    use axum::response::IntoResponse;
    use crate::testutil::{seeded_bundle, server_state};
    use std::path::PathBuf;

    /// A fresh Bundle root seeded with `note.md` + `sub/deep.md`.
    fn temp_bundle() -> PathBuf {
        seeded_bundle("read")
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
        let payload = render::render_concept(&root, &index, "note.md", &asset_url).unwrap();
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
    fn the_asset_mapper_matches_the_route_and_the_frontend() {
        // One shape, three places: this mapper, `routes_asset.rs`'s
        // `?path=` query, and `http.ts`'s `attachmentUrl`
        // (`encodeURIComponent`). A drift here silently 404s every Embed in the
        // SSR'd page, which no other test would notice.
        assert_eq!(asset_url("assets/logo.png"), "/_api/asset?path=assets%2Flogo.png");
        assert_eq!(asset_url("a b+c.png"), "/_api/asset?path=a%20b%2Bc.png");
        // A literal `%` in a filename is escaped, so ONE decode (axum's `Query`)
        // recovers it — the invariant `routes_asset.rs` pins from the other side.
        assert_eq!(asset_url("a%2Fb.png"), "/_api/asset?path=a%252Fb.png");
    }

    #[test]
    fn a_rendered_embed_points_at_the_asset_route() {
        let root = temp_bundle();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("assets/logo.png"), b"\x89PNG").unwrap();
        std::fs::write(root.join("note.md"), "![[logo.png]]\n").unwrap();
        let index = sunstone_native::index::Index::build(&root);
        let payload = render::render_concept(&root, &index, "note.md", &asset_url).unwrap();
        assert!(
            payload.html.contains(r#"src="/_api/asset?path=assets%2Flogo.png""#),
            "{}",
            payload.html
        );
    }

    /// What `/_api/attachment-paths` serves, over a real on-disk Bundle: the
    /// Attachment corpus, sorted, and DISJOINT from `/_api/concept-paths`. The
    /// handler itself is a three-line wrapper over this; the contract worth
    /// pinning is that the two routes never return each other's files (the
    /// `.md`-only concept list feeds the tree, Quick nav and wikilinks).
    #[test]
    fn the_attachment_paths_route_is_a_separate_corpus_from_concept_paths() {
        let root = temp_bundle(); // note.md + sub/deep.md
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("assets/logo.png"), b"\x89PNG").unwrap();
        std::fs::write(root.join("sub/mark.svg"), b"<svg/>").unwrap();
        let index = sunstone_native::index::Index::build(&root);

        assert_eq!(
            index.attachment_paths(),
            vec!["assets/logo.png".to_string(), "sub/mark.svg".to_string()]
        );
        let concepts = index.concept_paths();
        assert!(concepts.contains(&"note.md".to_string()));
        assert!(!concepts.iter().any(|p| p.ends_with(".png") || p.ends_with(".svg")));
    }

    #[test]
    fn render_route_rejects_path_escape_with_400() {
        let root = temp_bundle();
        let index = sunstone_native::index::Index::build(&root);
        let err = render::render_concept(&root, &index, "../secret.md", &asset_url).unwrap_err();
        assert_eq!(classify(&err), StatusCode::BAD_REQUEST);
    }

    /// The read routes refuse a hidden (dot-prefixed) component, so `.git/` and
    /// other entries the walker hides are unreachable over HTTP.
    #[tokio::test]
    async fn concept_and_render_routes_reject_a_hidden_path_with_400() {
        use crate::config::Config;
        let root = temp_bundle();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/notes.md"), "secret").unwrap();
        let state = server_state(Config::plain(root));
        for path in [".git/notes.md", "sub/../.git/notes.md"] {
            let q = || Query(ConceptQuery { path: path.to_string() });
            let err = concept_handler(State(state.clone()), q()).await.unwrap_err();
            assert_eq!(err.0, StatusCode::BAD_REQUEST, "{path}");
            let err = render_handler(State(state.clone()), q()).await.unwrap_err();
            assert_eq!(err.0, StatusCode::BAD_REQUEST, "{path}");
        }
    }

    /// `/_api/okf-markers` serves the index's declaring `index.md` files, in
    /// the camelCase shape the wasm `BundleIndex` constructor takes.
    #[tokio::test]
    async fn okf_markers_route_serves_the_declaring_index_files() {
        use crate::config::Config;
        let root = temp_bundle(); // note.md + sub/deep.md
        std::fs::write(root.join("sub/index.md"), "---\nokf_version: \"0.2\"\n---\n# Sub\n").unwrap();
        let state = server_state(Config::plain(root));
        let Ok(Json(markers)) = okf_markers_handler(State(state)).await else {
            panic!("okf-markers route failed");
        };
        assert_eq!(
            serde_json::to_value(&markers).unwrap(),
            serde_json::json!([{ "indexPath": "sub/index.md", "okfVersion": "0.2" }])
        );
    }

    /// `/_api/git-prefix` serves the Bundle's path within its repository, and
    /// `null` for a Bundle outside any.
    #[tokio::test]
    async fn git_prefix_route_locates_the_bundle_in_its_repository() {
        use crate::config::Config;
        let root = temp_bundle();
        let Json(plain) = git_prefix_handler(State(server_state(Config::plain(root.clone())))).await;
        assert_eq!(plain, None, "a temp Bundle is in no repository");
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let ok = std::process::Command::new("git")
            .current_dir(&root)
            .args(["init", "-q"])
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let Json(top) = git_prefix_handler(State(server_state(Config::plain(root.clone())))).await;
        assert_eq!(top.as_deref(), Some(""));
        let Json(sub) = git_prefix_handler(State(server_state(Config::plain(root.join("sub"))))).await;
        assert_eq!(sub.as_deref(), Some("sub"));
    }

    #[tokio::test]
    async fn version_route_reports_the_crate_version() {
        let Json(info) = version_handler().await;
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
        // Local builds pass no commit; the key is still present, as null.
        assert!(json.as_object().unwrap().contains_key("commit"));
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

    /// §10.3 wire contract of `/_api/events`: a `FileChange` goes out **unnamed**
    /// (no `event:` field, so it lands in `onmessage`), and a `SyncNotice` goes
    /// out as a **named** `sync` event (dispatched only to
    /// `addEventListener('sync', …)`), both as JSON `data:` payloads on the one
    /// connection.
    #[tokio::test]
    async fn events_route_leaves_file_unnamed_and_names_sync() {
        use crate::config::Config;
        use crate::sync::{SyncNotice, SyncNoticeKind};
        use sunstone_native::watcher::FileChange;

        let state = server_state(Config::plain(temp_bundle()));

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

        // `/_api/types` → distinct, sorted frontmatter `type` values.
        assert_eq!(index.all_types(), vec!["concept", "index"]);
        // `/_api/keys` → distinct, sorted top-level frontmatter keys.
        assert_eq!(
            index.all_keys(),
            vec!["description", "tags", "title", "type"]
        );
    }
}
