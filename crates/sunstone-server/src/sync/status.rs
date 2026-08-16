//! The sync loop's two operator/user surfaces: the `sync` SSE notice (§10.2)
//! and `GET /api/sync-status` (§10.5).

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::config::Shape;
use crate::conflict::Resolution;
use crate::ServerState;

// --- §10.2 the two user-facing events ---------------------------------------

/// Which of the two events happened. Serialized as `forked` / `deletionDropped`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncNoticeKind {
    /// A conflicting web copy was preserved beside the canonical file.
    Forked,
    /// A web deletion was dropped because origin modified the file (§9.3).
    DeletionDropped,
}

/// The `sync` SSE payload (§10.2): `{ kind, path, fork? }`, both paths
/// bundle-relative forward-slash.
///
/// **No author, no email** — the change channel deliberately carries only
/// `name`, and provenance lives in git. Sent to **all** connected clients and
/// worded **impersonally** by the frontend, never "your edit": author-scoping
/// was rejected (the client would match its session against a name, and the
/// author is usually absent), as was path-scoping to whoever has the file open
/// (it silently kills the dropped-deletion notice — whoever deleted a file is by
/// definition not viewing it).
///
/// **Push and fetch failures are never in here.** The loop is offline-tolerant,
/// nothing is lost, and there is no user action to take.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncNotice {
    /// `forked` | `deletionDropped`.
    pub kind: SyncNoticeKind,
    /// The canonical bundle-relative path the notice is about.
    pub path: String,
    /// The fork that was written — present for `forked`, omitted otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork: Option<String>,
}

impl SyncNotice {
    /// Derive the notice from the branch a resolution took (§9.4) — never from
    /// commit emptiness.
    pub fn from_resolution(resolution: &Resolution) -> SyncNotice {
        match resolution {
            Resolution::Forked { path, fork } => SyncNotice {
                kind: SyncNoticeKind::Forked,
                path: path.clone(),
                fork: Some(fork.clone()),
            },
            Resolution::DeletionDropped { path } => SyncNotice {
                kind: SyncNoticeKind::DeletionDropped,
                path: path.clone(),
                fork: None,
            },
        }
    }
}

// --- §10.5 GET /api/sync-status ---------------------------------------------

/// The operator status payload. **Content-free by rule:** no error strings, no
/// remote URL, no branch name — only booleans, counts, an age and the shape.
/// That rule is what makes it safe to leave **unauthenticated**, which is what
/// makes it usable from a monitoring probe without minting a token. Diagnostic
/// detail stays in the logs.
///
/// **Not a healthcheck** — an unreachable remote must not mark the container
/// unhealthy. **No UI consumes it** (ticket 16); `curl` and monitoring do.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// `plain` | `git-local` | `git-synced`. Confirming this after a deploy is
    /// the prescribed check — an empty `SUNSTONE_GIT_ORIGIN` silently
    /// downgrades git-synced to git-local (Spec 1 §1).
    pub shape: Shape,
    /// Whether the most recent fetch succeeded.
    pub last_fetch_ok: bool,
    /// Whether the most recent push succeeded.
    pub last_push_ok: bool,
    /// `rev-list --count origin/<branch>..HEAD` as of the last tick — literally
    /// *how much web work exists only in this container*, and the right thing to
    /// alert on. A persistent push failure (revoked key, protected branch) is
    /// the one place in this design where data is quietly at risk: it lives only
    /// in a volume classed as a disposable cache.
    pub pending_commits: usize,
    /// Seconds since the last completed tick, or `null` when none has completed
    /// (a shape with no loop, or a container still booting).
    pub last_sync_age_secs: Option<u64>,
}

/// `GET /api/sync-status` — **unauthenticated** (see [`SyncStatus`]). Answers in
/// every shape; a shape with no loop reports its defaults and a `null` age.
pub async fn sync_status_handler(State(state): State<Arc<ServerState>>) -> Json<SyncStatus> {
    Json(state.sync.snapshot(state.cfg.shape))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::SyncState;

    // --- §10.5's wire shape --------------------------------------------------

    #[test]
    fn sync_status_serializes_exactly_the_five_camel_case_fields() {
        let status = SyncState::new().snapshot(Shape::GitSynced);
        let value = serde_json::to_value(&status).unwrap();
        let object = value.as_object().expect("an object");

        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort();
        // **Content-free by rule**: no error strings, no remote URL, no branch
        // name — which is what makes the route safe unauthenticated.
        assert_eq!(
            keys,
            [
                "lastFetchOk",
                "lastPushOk",
                "lastSyncAgeSecs",
                "pendingCommits",
                "shape",
            ]
        );
        assert_eq!(object["shape"], serde_json::json!("git-synced"));
        assert_eq!(object["lastSyncAgeSecs"], serde_json::Value::Null);
        assert_eq!(object["pendingCommits"], serde_json::json!(0));
    }

    #[test]
    fn the_shape_is_reported_in_its_kebab_case_spelling() {
        for (shape, wire) in [
            (Shape::Plain, "plain"),
            (Shape::GitLocal, "git-local"),
            (Shape::GitSynced, "git-synced"),
        ] {
            let value = serde_json::to_value(SyncState::new().snapshot(shape)).unwrap();
            assert_eq!(value["shape"], serde_json::json!(wire));
        }
    }

    // --- §10.2's notice, at the boundary punch-list item 7 fixes -------------

    #[test]
    fn a_notice_is_built_from_the_bundle_relative_resolution() {
        // The resolver speaks **repo-root**-relative paths; §10.2's payload is
        // bundle-relative, so the strip happens here, before the notice.
        let forked = Resolution::Forked {
            path: "docs/notes/f.md".into(),
            fork: "docs/notes/f-20260726T101500Z.md".into(),
        };
        let local = forked.to_bundle_relative("docs").unwrap();
        let notice = SyncNotice::from_resolution(&local);
        assert_eq!(notice.kind, SyncNoticeKind::Forked);
        assert_eq!(notice.path, "notes/f.md");
        assert_eq!(notice.fork.as_deref(), Some("notes/f-20260726T101500Z.md"));

        let value = serde_json::to_value(&notice).unwrap();
        assert_eq!(value["kind"], serde_json::json!("forked"));
        assert_eq!(value["path"], serde_json::json!("notes/f.md"));

        // A conflict outside the Bundle is resolved but produces **no** notice.
        assert_eq!(forked.to_bundle_relative("other"), None);
    }

    #[test]
    fn a_dropped_deletion_notice_omits_the_fork_field() {
        let notice = SyncNotice::from_resolution(&Resolution::DeletionDropped {
            path: "notes/f.md".into(),
        });
        let value = serde_json::to_value(&notice).unwrap();
        assert_eq!(value["kind"], serde_json::json!("deletionDropped"));
        let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["kind", "path"], "no `fork` for a dropped deletion");
    }
}
