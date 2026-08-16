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
//! - `GET /api/events`               → SSE stream of `ServerEvent`s (unnamed
//!   `FileChange`s + named `sync` divergence notices)
//! - `GET /api/history?path=`        → `FileHistory` (gated — Spec 2 §11)
//! - `GET /api/file-at-rev?path=&rev=` → `FileAtRev` (gated — Spec 2 §11)
//! - `GET /api/sync-status`          → `SyncStatus` (unauthenticated, Spec 2 §10.5)
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
mod boot;
mod conflict;
mod config;
mod history;
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

// Re-exported at the crate root so sibling modules (`auth`, `history`, `sync`,
// `routes_read`, `routes_write`) can keep referring to these as `crate::…`
// regardless of which file they're physically defined in.
pub(crate) use routes_read::{guard_rel_path, ApiError};

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
/// the HS256 secret used to verify hook-minted write JWTs (ticket 04), the
/// parsed environment [`Config`] (Spec 2 §2 — nothing downstream re-reads the
/// environment), and the sync loop's shared state (§8.1/§10.5).
pub(crate) struct ServerState {
    pub(crate) app: Arc<AppState>,
    pub(crate) events: broadcast::Sender<ServerEvent>,
    /// Serializes every write op's entire write → (rewrite) → commit section
    /// (one Bundle = one working tree = one shared `index.lock`). The sync loop
    /// takes the **same** lock, so one owner touches the repo at a time.
    pub(crate) write_lock: Mutex<()>,
    /// Shared secret for verifying hook-minted write JWTs. `None` (env unset)
    /// disables writing — every write route 401s at the `AuthedUser` extractor.
    pub(crate) jwt_secret: Option<Vec<u8>>,
    /// The one parse of the environment: the deployment shape, the git family,
    /// the resolved bundle root. Read by the write path's shape gate (§5), the
    /// history handlers' plain-shape short-circuit (§11.1) and the loop.
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
    // our sink fans it out over the broadcast channel. No self-write
    // suppression matters here — the web server never writes.
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
    let jwt_secret = cfg.jwt_secret.clone();
    if jwt_secret.is_none() {
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
        jwt_secret,
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
        .route(
            "/api/concept-exists",
            get(routes_read::concept_exists_handler),
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
    use config::Config;
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
    fn router_builds_over_server_state() {
        // Smoke: constructing the router with a real ServerState (index built on
        // startup + a broadcast sender) must not panic.
        let root = temp_bundle();
        let (events, _) = broadcast::channel::<ServerEvent>(8);
        let _app = router(Arc::new(ServerState {
            app: Arc::new(AppState::new(root.clone())),
            events,
            write_lock: Mutex::new(()),
            jwt_secret: None,
            cfg: Config::plain(root),
            sync: SyncState::new(),
        }));
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
