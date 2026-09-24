//! Sunstone Web's HTTP server: a thin axum binary over `sunstone-native` — the
//! SAME bundle/index/render/git logic the Tauri desktop shell uses.
//!
//! `main` parses the environment once ([`config`]), runs the ordered boot
//! sequence ([`boot`]), builds the index, starts the watcher and (git-synced
//! shape only) the sync loop, then serves the API. The route table is
//! [`router`]; handlers live in `routes_read`, `routes_write`, `routes_asset`,
//! `history` and `sync`. The architecture doc is
//! `docs/architecture/sunstone-server.md`.

mod api_error;
mod auth;
mod boot;
mod conflict;
mod config;
mod history;
mod routes_asset;
mod routes_read;
mod routes_write;
mod sync;
#[cfg(test)]
mod testutil;
mod write;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::{
    routing::{get, post},
    Router,
};
use tokio::sync::broadcast;

use sunstone_native::app_state::AppState;
use sunstone_native::watcher::{self, FileChange};
use sync::{SyncNotice, SyncState};

// Re-exported at the crate root so sibling modules (`history`, …) can refer to
// these as `crate::…` regardless of which file they're physically defined in.
pub(crate) use api_error::{guard_rel_path, ApiError};

use config::Config;

/// Default HTTP port. Overridable via `SUNSTONE_API_PORT`.
const DEFAULT_PORT: u16 = 8787;

/// Capacity of the filesystem-change broadcast channel. A slow SSE consumer that
/// falls this far behind sees a lag error (skipped, not fatal).
const EVENTS_CHANNEL_CAP: usize = 256;

/// Everything that reaches a client over the one SSE connection (Spec 2 §10.3).
///
/// `events_handler` matches on this to pick the SSE `event:` name. The `File`
/// variant is emitted with **no event name**, exactly as before, so it keeps
/// landing in the browser's `onmessage` and `parseFileChange` — no existing type
/// changes, no second connection, no second keep-alive. `Sync` is emitted as a
/// named `sync` event, which `EventSource` dispatches **only** to
/// `addEventListener('sync', …)`, leaving every existing client untouched.
#[derive(Clone, Debug)]
pub(crate) enum ServerEvent {
    /// A filesystem change: the watcher's unstamped one, or a write path's
    /// `origin`-stamped one. Unnamed on the wire.
    File(FileChange),
    /// A divergence notice from the sync loop (§10.2). Named `sync`.
    Sync(SyncNotice),
}

/// Shared server state: the domain `AppState` (bundle root + index), the
/// broadcast sender every `/api/events` connection subscribes to, the global
/// write lock serializing the write→commit critical section (ticket 05/07 §4),
/// the parsed environment [`Config`] (Spec 2 §2 — nothing downstream re-reads the
/// environment), and the sync loop's shared state (§8.1/§10.5).
pub(crate) struct ServerState {
    pub(crate) app: Arc<AppState>,
    pub(crate) events: broadcast::Sender<ServerEvent>,
    /// Serializes every write op's entire write → (rewrite) → commit section
    /// (one Bundle = one working tree = one shared `index.lock`). The sync loop
    /// takes the **same** lock, so one owner touches the repo at a time.
    pub(crate) write_lock: Mutex<()>,
    /// The one parse of the environment: the deployment shape, the git family,
    /// the resolved bundle root, the write-JWT secret. Read by the write path's
    /// shape gate (§5), the history handlers' plain-shape short-circuit (§11.1),
    /// the `AuthedUser` extractor (`jwt_secret`: `None` disables writing — every
    /// write route 401s) and the loop.
    pub(crate) cfg: Config,
    /// The loop's wake-up `Notify` plus the counters `GET /api/sync-status`
    /// reports. Present in every shape; only the git-synced shape mutates it.
    pub(crate) sync: SyncState,
}

#[tokio::main]
async fn main() {
    // §4.1 — one pure parse of the environment, via `parse_env` and NOT `parse`:
    // only the real key *names* let §2.2's closed-namespace check see an
    // unrecognised `SUNSTONE_GIT_*`, which is what catches a typo'd
    // `SUNSTONE_GIT_ORGIN` and — load-bearing — a stale sidecar env file still
    // carrying `SUNSTONE_GIT_REPO` / `_REF` / `_PERIOD`. `parse`'s key-lookup
    // closure cannot enumerate anything, so calling it would make that check
    // silently do nothing.
    let names = std::env::vars().map(|(name, _)| name);
    let mut cfg = match config::parse_env(names, |key| std::env::var(key).ok()) {
        Ok(cfg) => cfg,
        Err(errors) => {
            // Print **every** error, not just the first (§2/§4.1): N typos cost
            // one crash-loop rather than N. `ConfigError` renders the message body
            // only, so the crate's `sunstone-server: ` prefix is added here.
            for error in &errors {
                eprintln!("sunstone-server: {error}");
            }
            std::process::exit(1);
        }
    };
    // §2.4's one log-and-ignore case.
    for warning in &cfg.warnings {
        eprintln!("sunstone-server: {warning}");
    }

    // §4.2–§4.6 — ssh material + `git::configure`, the optional seed copy, the
    // `/srv/repo` state machine, the bundle-root resolution and the two
    // writability preflights, strictly ordered. Every `Err` is an actionable
    // message (again body-only) and a non-zero exit.
    let boot = match boot::run(&cfg) {
        Ok(outcome) => outcome,
        Err(e) => {
            eprintln!("sunstone-server: {e}");
            std::process::exit(1);
        }
    };

    // The boot sequence canonicalized both roots (a clone may have created them),
    // so the config the loop and the write path read carries the resolved values
    // rather than the pre-boot guesses.
    cfg.bundle_root = boot.bundle_root.clone();
    cfg.repo_root = boot.repo_root.clone();

    let root = boot.bundle_root.clone();
    eprintln!("sunstone-server: shape {}", cfg.shape.as_str());
    if boot.seeded {
        eprintln!("sunstone-server: seeded the bundle root before any git step");
    }
    match boot.repo_action {
        boot::RepoAction::None => {}
        boot::RepoAction::Cloned => eprintln!("sunstone-server: cloned the repository from origin"),
        boot::RepoAction::Adopted => eprintln!("sunstone-server: adopted the existing repository"),
        boot::RepoAction::Initialized => {
            eprintln!("sunstone-server: initialised a local repository with a seed commit")
        }
    }
    eprintln!("sunstone-server: serving bundle {}", root.display());

    // Reuse the desktop's AppState (canonical root + in-memory index built on
    // startup); the index is kept current by the watcher below.
    let app_state = Arc::new(AppState::new(root.clone()));

    // Broadcast filesystem changes to every connected SSE client. The core
    // watcher is host-agnostic: it hands us each `FileChange` through a sink;
    // our sink fans it out over the broadcast channel. The write path mutes the
    // watcher's echo of its own writes (`note_self_write`) and broadcasts one
    // `origin`-stamped change instead, so what arrives here is external.
    let (events, _) = broadcast::channel::<ServerEvent>(EVENTS_CHANNEL_CAP);
    let sink_tx = events.clone();
    // Kept bound (NOT dropped) for the process lifetime so watching continues.
    let _watcher = match watcher::start(root, app_state.clone(), move |change| {
        // Err only means "no subscribers right now" — fine to ignore.
        let _ = sink_tx.send(ServerEvent::File(change));
    }) {
        Ok(w) => Some(watcher::WatcherHandle::new(w)),
        Err(e) => {
            eprintln!("sunstone-server: filesystem watcher failed to start: {e}");
            None
        }
    };

    // Write auth: the HS256 secret shared with the SvelteKit `/api` hook, read
    // off the one parse above (nothing downstream re-reads the environment).
    // Absent → writing is disabled (every write route 401s) — a safe read-only
    // default — and, per §11, so is history.
    if cfg.jwt_secret.is_none() {
        eprintln!(
            "sunstone-server: {} unset — write routes are disabled (read-only)",
            auth::SECRET_ENV
        );
    }

    let port = cfg.api_port;
    let state = Arc::new(ServerState {
        app: app_state,
        events,
        write_lock: Mutex::new(()),
        cfg,
        sync: SyncState::new(),
    });

    // §4.7 — the loop runs **only** in the git-synced shape: git-local has no
    // remote to fetch from or push to, and plain runs no git at all. Kept bound
    // is unnecessary (the task owns its `Arc`), so the handle is dropped.
    if state.cfg.shape.syncs() {
        sync::spawn(state.clone());
    }

    let app = router(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {addr}: {e}"));
    eprintln!("sunstone-server: listening on http://{addr}");
    axum::serve(listener, app).await.expect("server error");
}

/// Build the full route table (read + write) over a `ServerState`.
fn router(state: Arc<ServerState>) -> Router {
    Router::new()
        // `/api/concept` carries the read (GET) plus the per-method write verbs
        // (ticket 07 §1): PUT overwrites, POST creates, DELETE removes (by query).
        .route(
            "/api/concept",
            get(routes_read::concept_handler)
                .put(routes_write::write_concept_handler)
                .post(routes_write::create_concept_handler)
                .delete(routes_write::delete_concept_handler),
        )
        .route("/api/folder", post(routes_write::create_folder_handler))
        .route("/api/rename", post(routes_write::rename_handler))
        .route("/api/move", post(routes_write::move_handler))
        .route(
            "/api/rewrite-anchors",
            post(routes_write::rewrite_anchors_handler),
        )
        .route("/api/bundle-root", get(routes_read::bundle_root_handler))
        .route("/api/tree", get(routes_read::tree_handler))
        .route("/api/render", get(routes_read::render_handler))
        // Attachment bytes (ADR-0011). Unauthenticated, exactly like
        // `/api/concept` and `/api/render`: an Attachment is as readable as the
        // Concept that embeds it.
        .route("/api/asset", get(routes_asset::asset_handler))
        .route("/api/search", get(routes_read::search_handler))
        .route("/api/backlinks", get(routes_read::backlinks_handler))
        .route("/api/tags", get(routes_read::tags_handler))
        .route(
            "/api/concepts-by-tag",
            get(routes_read::concepts_by_tag_handler),
        )
        .route("/api/types", get(routes_read::types_handler))
        .route("/api/keys", get(routes_read::keys_handler))
        .route(
            "/api/concept-paths",
            get(routes_read::concept_paths_handler),
        )
        // The Attachment counterpart of `/api/concept-paths` — a separate list,
        // not a filter (the index keeps the two corpora apart). Unauthenticated
        // for the same reason `/api/asset` is.
        .route(
            "/api/attachment-paths",
            get(routes_read::attachment_paths_handler),
        )
        .route("/api/events", get(routes_read::events_handler))
        // Git history (Spec 2 §11) — both gated by the `AuthedUser` extractor,
        // because `file-at-rev` returns the full text of any path at any
        // revision, including content deliberately deleted from the Bundle.
        .route("/api/history", get(history::history_handler))
        .route("/api/file-at-rev", get(history::file_at_rev_handler))
        // Operator status (§10.5) — deliberately UNAUTHENTICATED and
        // content-free, so a monitoring probe needs no token.
        .route("/api/sync-status", get(sync::sync_status_handler))
        .with_state(state)
}

// Bundle-root resolution lives in `config::parse_env` (the `SUNSTONE_BUNDLE` read
// and the `CARGO_MANIFEST_DIR`-relative dev fallback) plus
// `boot::resolve_bundle_root` (the canonicalization and the git-shape join), so
// the duplicate pair that used to sit here is gone rather than left to drift.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{seeded_bundle, server_state};
    use config::Config;
    use std::path::PathBuf;

    /// A fresh Bundle root seeded with `note.md` + `sub/deep.md`.
    fn temp_bundle() -> PathBuf {
        seeded_bundle("main")
    }

    #[test]
    fn router_builds_over_server_state() {
        // Smoke: constructing the router with a real ServerState (index built on
        // startup + a broadcast sender) must not panic.
        let _app = router(server_state(Config::plain(temp_bundle())));
    }

    #[tokio::test]
    async fn broadcast_fans_a_change_out_to_every_subscriber() {
        // The SSE wiring: a change sent on the broadcast sender reaches every
        // subscribed receiver (each SSE connection is one subscriber).
        let (tx, _) = broadcast::channel::<ServerEvent>(8);
        let mut a = tx.subscribe();
        let mut b = tx.subscribe();
        let change = FileChange {
            kind: "modified".to_string(),
            paths: vec!["note.md".to_string()],
            origin: None,
        };
        tx.send(ServerEvent::File(change)).unwrap();
        let ServerEvent::File(ra) = a.recv().await.unwrap() else {
            panic!("expected a File event");
        };
        let ServerEvent::File(rb) = b.recv().await.unwrap() else {
            panic!("expected a File event");
        };
        assert_eq!(ra.kind, "modified");
        assert_eq!(ra.paths, vec!["note.md".to_string()]);
        assert_eq!(rb.paths, ra.paths);
    }
}
