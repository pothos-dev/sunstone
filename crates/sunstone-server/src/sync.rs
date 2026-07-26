//! The sync loop (Spec 2 §8) plus its two operator/user surfaces: the `sync`
//! SSE notice (§10.2) and `GET /api/sync-status` (§10.5). **git-synced only.**
//!
//! # Scheduling (§8.1)
//!
//! A tokio task waiting on a [`tokio::sync::Notify`] **with a timeout** of
//! `SUNSTONE_GIT_SYNC_INTERVAL_SECS`, waking on either. Each tick takes the
//! **same `write_lock`** the write path takes — one owner, so an in-process
//! mutex is enough: no `.git/index.lock` races, no cross-process flock.
//!
//! - **Outbound latency: immediate**, independent of the interval (the write
//!   path kicks it after releasing the lock, §5).
//! - **Inbound latency: up to one interval** — external pushes wait only for
//!   discovery, which is inherently a poll.
//! - **Save-storms coalesce by construction**: N signals during one in-flight
//!   sync collapse into one follow-up run.
//!
//! # Rules the loop must obey (§8.3)
//!
//! - **Push is fast-forward only.** origin can advance between our fetch and our
//!   push; the rejection is expected. Re-fetch, re-rebase and retry **next
//!   tick** — never force-push.
//! - **Never `stash`, never `reset --hard`, never `clean`.** If rebase refuses
//!   because the tree is dirty, log it and skip the tick. Discarding a tree that
//!   may hold an in-flight edit is worse than a stalled sync.
//! - **Bounded and self-healing.** The resolve loop is bounded on **progress**,
//!   not effort — each stop consumes one replayed commit, so more stops than
//!   commits means the rebase is not advancing ([`MAX_RESOLVE_ITERATIONS`] is
//!   only a runaway backstop). On any state the resolver does not recognise,
//!   `rebase --abort`, log with the git error text, and retry next tick. An
//!   aborted rebase is idempotent — §9's resolution is baked into the replayed
//!   commit, so a retry does not re-fork.
//! - **The loop broadcasts nothing and calls no `note_self_write`.** Its
//!   rewrites reach clients through the ordinary watcher path (§10.1) as
//!   unstamped `origin: None` changes the frontend already routes. The one thing
//!   it *does* send on the event channel is a [`SyncNotice`].
//!
//! # Logging discipline (§10.6)
//!
//! `eprintln!` in the existing `sunstone-server: …` style — no `tracing`
//! dependency. **Quiet by default:** a successful no-op tick logs *nothing* (at
//! a 10s interval a line per tick would be ~8,600 lines/day of "nothing to do",
//! making the log useless exactly when someone reads it after a failure).
//! Content changes always log; transport failures log **on transition only**,
//! the first one carrying the git error text — this is the one place that detail
//! lives, given the status route strips it.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use axum::extract::State;
use axum::Json;
use serde::Serialize;
use tokio::sync::Notify;

use sunstone_native::git::{self, RebaseOutcome};

use crate::config::{Config, GitConfig, Shape};
use crate::conflict::{self, ForkMap, Resolution};
use crate::{ServerEvent, ServerState};

/// Absolute runaway backstop on one rebase's resolve iterations (§8.3,
/// "bounded and self-healing").
///
/// This is **not** the real bound — the real bound is progress, see
/// [`integrate`]. Each rebase stop consumes exactly one replayed commit
/// (`--continue` commits it, `--skip` drops it), so the legitimate number of
/// stops is the number of commits being replayed, which §9.1 explicitly expects
/// to be large after an offline stretch. A fixed ceiling below that would turn
/// the *designed-for* case into a permanent stall.
///
/// So this value exists only to stop a genuinely unbounded spin (a miscounted
/// `ahead`, a git that reports `Stopped` forever) and is set far above any real
/// replay.
pub const MAX_RESOLVE_ITERATIONS: usize = 10_000;

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

// --- Shared state -----------------------------------------------------------

/// The loop's shared, mutable state: the wake-up [`Notify`] plus everything
/// [`SyncStatus`] reports and everything §10.6's transition logging needs.
/// Written by the loop under the write lock, read by the status route.
///
/// `pendingCommits` is the value the last tick computed rather than a live
/// `rev-list`, so the status route stays a lock-and-copy and never spawns git.
pub struct SyncState {
    /// Kicked by the write path after it releases the write lock (§5) and by
    /// the interval timeout (§8.1). The loop's first act on waking is to acquire
    /// a free lock.
    pub notify: Notify,
    inner: Mutex<SyncInner>,
}

/// The mutex-guarded interior of [`SyncState`].
struct SyncInner {
    last_fetch_ok: bool,
    last_push_ok: bool,
    pending_commits: usize,
    /// When the last tick completed; `None` until the first one does.
    last_sync: Option<Instant>,
    /// §10.6 transition tracking: whether we are currently in a logged fetch /
    /// push failure streak, and how many push attempts it has lasted (so
    /// recovery can log `push recovered after N attempts`).
    fetch_failing: bool,
    push_failing: bool,
    push_attempts: u32,
    /// The last tick error logged, so an anomaly that recurs every interval
    /// (a repo with no HEAD, say) is not ~8,600 identical lines/day. Same
    /// quiet-by-default reasoning as the transport transitions (§10.6); cleared
    /// by the next completed tick.
    last_error: Option<String>,
}

impl SyncState {
    /// Fresh state: nothing has synced yet, both transports optimistically `ok`
    /// so a plain / git-local deployment does not report a failure it never had.
    pub fn new() -> SyncState {
        SyncState {
            notify: Notify::new(),
            inner: Mutex::new(SyncInner {
                last_fetch_ok: true,
                last_push_ok: true,
                pending_commits: 0,
                last_sync: None,
                fetch_failing: false,
                push_failing: false,
                push_attempts: 0,
                last_error: None,
            }),
        }
    }

    /// The interior, tolerating a poisoned lock by taking it anyway.
    ///
    /// A tick that panicked must not turn `GET /api/sync-status` — the
    /// unauthenticated probe surface — into a 500: the counters are plain values,
    /// so the worst case is a stale reading of exactly the fields §10.5 already
    /// describes as "as of the last tick".
    fn lock(&self) -> MutexGuard<'_, SyncInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Wake the loop now (`notify_one`). Called by the write path **after**
    /// releasing the write lock, so the loop's first act is to acquire a free
    /// one; a no-op when no loop is running.
    pub fn kick(&self) {
        self.notify.notify_one();
    }

    /// Copy the current state into the wire payload, stamping `shape`.
    ///
    /// A **lock-and-copy**: it never spawns git (§10.5), so the route stays cheap
    /// enough for a monitoring probe on a short period and cannot contend with
    /// the write lock.
    pub fn snapshot(&self, shape: Shape) -> SyncStatus {
        let inner = self.lock();
        SyncStatus {
            shape,
            last_fetch_ok: inner.last_fetch_ok,
            last_push_ok: inner.last_push_ok,
            pending_commits: inner.pending_commits,
            last_sync_age_secs: age_secs(inner.last_sync, Instant::now()),
        }
    }

    /// Record a completed fetch: updates `lastFetchOk`, and returns whether this
    /// is a **transition** worth logging (§10.6 — the first failure logs with the
    /// git error text; subsequent identical failures are silent; recovery logs
    /// once).
    pub fn note_fetch(&self, ok: bool) -> bool {
        let mut inner = self.lock();
        inner.last_fetch_ok = ok;
        // A transition is a *change* of streak state in either direction: the
        // first failure logs (with git's text), repeats are silent, and the
        // recovery logs once.
        let transition = inner.fetch_failing != !ok;
        inner.fetch_failing = !ok;
        transition
    }

    /// Record a completed push, same transition contract as [`Self::note_fetch`].
    /// The attempt counter feeds `push recovered after N attempts`.
    ///
    /// **Not called for a fast-forward rejection** — see [`tick`]: that is an
    /// expected race, not a transport verdict.
    pub fn note_push(&self, ok: bool) -> bool {
        let mut inner = self.lock();
        inner.last_push_ok = ok;
        let transition = inner.push_failing != !ok;
        if ok {
            inner.push_failing = false;
            // `push_attempts` is deliberately **not** cleared here: the recovery
            // line is logged immediately after this call and reads it through
            // [`Self::push_attempts`]. The next failure starts a fresh streak at 1.
        } else {
            inner.push_attempts = if inner.push_failing {
                inner.push_attempts.saturating_add(1)
            } else {
                1
            };
            inner.push_failing = true;
        }
        transition
    }

    /// How many attempts the current (or just-ended) push failure streak lasted —
    /// the `N` in §10.6's `push recovered after N attempts`.
    pub fn push_attempts(&self) -> u32 {
        self.lock().push_attempts
    }

    /// Record the end of a tick: the fresh `pendingCommits` count and now as the
    /// last-sync instant.
    pub fn note_tick(&self, pending_commits: usize) {
        let mut inner = self.lock();
        inner.pending_commits = pending_commits;
        inner.last_sync = Some(Instant::now());
        // A completed tick clears the anomaly memo, so a problem that recurs
        // after a healthy stretch is logged again rather than swallowed.
        inner.last_error = None;
    }

    /// Record a tick that could not be completed, returning whether this message
    /// is **new** and therefore worth a log line. Same discipline as the
    /// transport transitions (§10.6): the first occurrence carries the git error
    /// text, an identical repeat every interval is silent.
    pub fn note_tick_error(&self, msg: &str) -> bool {
        let mut inner = self.lock();
        if inner.last_error.as_deref() == Some(msg) {
            return false;
        }
        inner.last_error = Some(msg.to_string());
        true
    }
}

/// `lastSyncAgeSecs`: whole seconds since the last **completed** tick, or `None`
/// when none has completed (a shape with no loop, a container still booting, or
/// a stretch in which every tick was skipped). Pure, so the rounding is testable
/// without sleeping.
fn age_secs(last_sync: Option<Instant>, now: Instant) -> Option<u64> {
    last_sync.map(|last| now.saturating_duration_since(last).as_secs())
}

impl Default for SyncState {
    fn default() -> Self {
        SyncState::new()
    }
}

// --- The loop ---------------------------------------------------------------

/// Spawn the loop task. Called from `main()` **only** in the git-synced shape
/// (§4.7), after the boot sequence.
pub fn spawn(state: Arc<ServerState>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(run(state))
}

/// The loop task body (§8.1): forever, wait on `state.sync.notify` with a
/// timeout of the configured interval, then run one [`tick`] on a blocking
/// thread while holding `state.write_lock`, and broadcast each returned
/// [`SyncNotice`] as a `ServerEvent::Sync`.
///
/// Takes the shared state rather than a bag of parameters because the tick needs
/// the config, the repo root, the write lock, the event sender and
/// [`SyncState`]; the `Notify` it waits on is `state.sync.notify`.
pub async fn run(state: Arc<ServerState>) {
    // Both are `Some` in the git-synced shape `main()` spawns us in; anything
    // else is a wiring mistake, so say so once and stop rather than tick forever
    // over a `None`.
    let (Some(git_cfg), Some(repo_root)) = (state.cfg.git(), state.cfg.repo_root.clone()) else {
        eprintln!("sunstone-server: sync loop not started — no git configuration");
        return;
    };
    let interval = git_cfg.sync_interval;
    eprintln!(
        "sunstone-server: sync loop against {} every {}s",
        git_cfg.upstream_ref(),
        interval.as_secs()
    );

    loop {
        // Tick **first**: an adopted volume can already hold a previous
        // container's unpushed commits, and making them wait an interval buys
        // nothing.
        run_tick(&state, &repo_root).await;

        // §8.1 — notified *or* timeout, whichever comes first. `Notify` holds at
        // most one permit, so the N kicks a save-storm fires while the tick above
        // was in flight collapse into exactly one follow-up run: that is the
        // coalescing, by construction rather than by bookkeeping.
        let _ = tokio::time::timeout(interval, state.sync.notify.notified()).await;
    }
}

/// One scheduled tick: run [`tick`] on a blocking thread while holding the
/// **same** `write_lock` the write path takes, then broadcast whatever it
/// returned as named `sync` events.
///
/// The lock is taken *inside* `spawn_blocking` so the guard never crosses an
/// `await`, and the tick's git children never run on a runtime worker thread.
async fn run_tick(state: &Arc<ServerState>, repo_root: &Path) {
    let owned = state.clone();
    let root = repo_root.to_path_buf();
    let joined = tokio::task::spawn_blocking(move || -> Result<Vec<SyncNotice>, String> {
        // Recover from poisoning, exactly as `SyncState::lock` does: a panic in
        // some other holder of this mutex says nothing about whether the git
        // repository is usable, and treating it as fatal would silently stop
        // syncing for the rest of the process's life — one deduped log line while
        // `pendingCommits` climbs.
        let _guard = owned
            .write_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        tick(&owned.cfg, &root, &owned.sync)
    })
    .await;

    match joined {
        // The only thing the loop ever broadcasts (§8.3): the two §10.2 notices.
        // File content reaches clients through the ordinary watcher path (§10.1).
        Ok(Ok(notices)) => {
            for notice in notices {
                // Err only means "no subscribers right now" — fine to ignore.
                let _ = state.events.send(ServerEvent::Sync(notice));
            }
        }
        Ok(Err(e)) => {
            if state.sync.note_tick_error(&e) {
                eprintln!("sunstone-server: sync tick failed: {e}");
            }
        }
        Err(join) => eprintln!("sunstone-server: sync task failed: {join}"),
    }
}

/// One tick (§8.2), blocking and run under the write lock:
///
/// ```text
/// fetch origin <branch>                     → on failure: log-on-transition, return
/// ahead  = rev_list_count("origin/<b>..HEAD")
/// behind = rev_list_count("HEAD..origin/<b>")
/// if ahead == 0 && behind == 0: return          # silent; the common case
/// if behind > 0:
///     rebase -Xno-renames origin/<branch>
///     while rebase is stopped:
///         resolutions = resolve_all_unmerged()   # §9
///         if nothing is staged for this commit:  # every conflict was a dropped web delete
///             rebase --skip
///         else:
///             rebase --continue
/// if ahead > 0 (recomputed):
///     push origin HEAD:refs/heads/<branch>   # fast-forward; rejection is normal
/// ```
///
/// `repo_root` is the repository root, **not** the bundle root: the rebase
/// covers the whole repo even when the Bundle is a subdir. Returns the notices
/// to broadcast, derived from each [`Resolution`]'s branch (§9.4). `Err` is a
/// tick that could not be completed — logged per §10.6, retried next tick.
pub fn tick(cfg: &Config, repo_root: &Path, sync: &SyncState) -> Result<Vec<SyncNotice>, String> {
    let git_cfg = cfg
        .git()
        .ok_or_else(|| "the sync loop ran in a shape with no git configuration".to_string())?;
    let branch = git_cfg.branch.as_str();
    let upstream = git_cfg.upstream_ref();

    // --- fetch --------------------------------------------------------------
    //
    // Offline-tolerant: a failure logs **on transition only** (with git's own
    // text, the one place that detail lives) and the tick returns. Nothing is
    // lost, there is no user-facing notice (§10.2), and no tick is *completed*,
    // so `lastSyncAgeSecs` keeps growing — which is the operator's signal.
    if let Err(e) = git::fetch(repo_root, branch) {
        if sync.note_fetch(false) {
            eprintln!("sunstone-server: fetch from {upstream} failed: {e}");
        }
        return Ok(Vec::new());
    }
    if sync.note_fetch(true) {
        eprintln!("sunstone-server: fetch from {upstream} recovered");
    }

    let ahead = git::rev_list_count(repo_root, &format!("{upstream}..HEAD"))?;
    let behind = git::rev_list_count(repo_root, &format!("HEAD..{upstream}"))?;

    // The common case, and the reason the log is readable: in sync ⇒ **silent**.
    if ahead == 0 && behind == 0 {
        sync.note_tick(0);
        return Ok(Vec::new());
    }

    // --- rebase (inbound) ---------------------------------------------------
    let mut notices = Vec::new();
    if behind > 0 {
        match integrate(git_cfg, repo_root, behind, ahead, sync)? {
            Some(from_rebase) => notices = from_rebase,
            // §8.3's refusal: logged, tree untouched, whole tick skipped. Pushing
            // now would be a non-fast-forward anyway, since we are still behind.
            None => return Ok(Vec::new()),
        }
    }

    // --- push (outbound) ----------------------------------------------------
    //
    // Recomputed: the rebase may have replayed our commits, and a `--skip`ped
    // empty commit means there is less to push than there was.
    let ahead = git::rev_list_count(repo_root, &format!("{upstream}..HEAD"))?;
    let mut pending = ahead;
    if ahead > 0 {
        match git::push(repo_root, branch) {
            Ok(()) => {
                // A fast-forward push advances `refs/remotes/origin/<branch>` too,
                // so nothing is pending any more — no second `rev-list` needed.
                pending = 0;
                if sync.note_push(true) {
                    eprintln!(
                        "sunstone-server: push recovered after {} attempts",
                        sync.push_attempts()
                    );
                }
            }
            // origin advanced between our fetch and our push. **Expected** (§8.3):
            // re-fetch, re-rebase and retry next tick, never force-push. It is not
            // a transport verdict, so it neither logs nor flips `lastPushOk`; the
            // signal that work is stuck here is `pendingCommits`, which stays up.
            Err(e) if git::is_push_rejected(&e) => {}
            Err(e) => {
                if sync.note_push(false) {
                    eprintln!("sunstone-server: push to {upstream} failed: {e}");
                }
            }
        }
    }

    sync.note_tick(pending);
    Ok(notices)
}

/// The inbound half of a tick: `rebase -Xno-renames origin/<branch>`, resolving
/// every stop through §9 until the rebase finishes.
///
/// `Ok(Some(notices))` — the rebase completed; `Ok(None)` — git **refused** to
/// start (§8.3, e.g. a dirty working tree), so the caller skips the tick and the
/// tree is left exactly as it was: never `stash`, never `reset --hard`, never
/// `clean`. `Err` — a state the resolver does not recognise: the rebase has been
/// aborted and the message carries git's own text.
fn integrate(
    git_cfg: &GitConfig,
    repo_root: &Path,
    behind: usize,
    ahead: usize,
    sync: &SyncState,
) -> Result<Option<Vec<SyncNotice>>, String> {
    let upstream = git_cfg.upstream_ref();
    // **ONE `ForkMap` for the whole run** (§9's coalescing row): N replayed
    // commits touching one path write to the same fork, which then holds the
    // final content.
    let mut forks = ForkMap::new();
    // Accumulated across every stop and deduplicated, so a path forked by three
    // replayed commits is one log line and one notice — matching the one fork the
    // map actually minted.
    let mut resolutions: Vec<Resolution> = Vec::new();

    // The bound is **progress, not effort** (§8.3 "bounded and self-healing").
    //
    // Each stop consumes exactly one replayed commit — `--continue` commits it,
    // `--skip` drops it — so `ahead` stops is the most a converging rebase can
    // legitimately need. §9.1 expects that number to be large (an offline stretch
    // replays N commits touching one path and *each* re-conflicts), which is
    // precisely why this cannot be a fixed ceiling: one would make the
    // designed-for case stall on every tick forever.
    //
    // Exceeding it means we stopped more times than there were commits to
    // consume, i.e. the rebase is not advancing — a state we do not model.
    let max_stops = ahead.max(1);
    let mut outcome = git::rebase_onto(repo_root, &git_cfg.branch)?;
    let mut iterations = 0usize;
    while outcome == RebaseOutcome::Stopped {
        iterations += 1;
        if iterations > max_stops || iterations > MAX_RESOLVE_ITERATIONS {
            let why = if iterations > max_stops {
                format!(
                    "the rebase stopped {iterations} times but only {ahead} commit(s) were being \
                     replayed, so it is not advancing"
                )
            } else {
                format!("the conflict resolver exceeded the {MAX_RESOLVE_ITERATIONS}-stop backstop")
            };
            return Err(abort(repo_root, why));
        }

        // §9's `<ts>`: the **author date of the commit being replayed**, so an
        // aborted-rebase retry mints the same name.
        let ts = conflict::fork_timestamp(
            git::rebase_head_timestamp(repo_root)
                .unwrap_or_default()
                .as_str(),
        );
        match conflict::resolve_all_unmerged(repo_root, &mut forks, &ts) {
            Ok(resolved) => {
                for resolution in resolved {
                    if !resolutions.contains(&resolution) {
                        resolutions.push(resolution);
                    }
                }
            }
            Err(e) => return Err(abort(repo_root, e)),
        }

        // §9.4: **emptiness decides continue-vs-skip and nothing else** — every
        // conflict may have been a dropped web deletion, and `--continue` refuses
        // an empty commit. The notices above are already recorded either way.
        let stepped = match git::anything_staged(repo_root) {
            Ok(true) => git::rebase_continue(repo_root),
            Ok(false) => git::rebase_skip(repo_root),
            Err(e) => return Err(abort(repo_root, e)),
        };
        outcome = match stepped {
            Ok(outcome) => outcome,
            Err(e) => return Err(abort(repo_root, e)),
        };
    }

    match outcome {
        RebaseOutcome::Completed => {}
        RebaseOutcome::Refused { reason } if iterations == 0 => {
            // Git never started — the dirty-tree case §8.3 names. Log it and skip;
            // the tree is left exactly as it was.
            //
            // Deduplicated like every other repeating condition (§10.6, "quiet by
            // default"): a tree that stays dirty refuses on *every* tick, which at
            // the 10s default would be ~8,600 identical lines/day — exactly the
            // noise that makes the log useless when someone finally reads it.
            let msg = format!(
                "rebase onto {upstream} refused, skipping this sync \
                 (the working tree is left untouched): {reason}"
            );
            if sync.note_tick_error(&msg) {
                eprintln!("sunstone-server: {msg}");
            }
            return Ok(None);
        }
        // A refusal *mid-run* is a state we do not model: unwind and retry.
        RebaseOutcome::Refused { reason } => return Err(abort(repo_root, reason)),
        RebaseOutcome::Stopped => unreachable!("the loop above exits only when not Stopped"),
    }

    // Content changed, so this **always** logs (§10.6) — the conflict/fork and
    // dropped-deletion lines first, then the one integration line.
    let mut notices = Vec::new();
    for resolution in &resolutions {
        // Punch list 7 / §10.2: strip to bundle-relative **before** building the
        // notice. `None` = the conflict was outside the Bundle: still resolved
        // (or `--continue` would refuse), still logged for the operator, but no
        // notice, because a path no client can open is noise.
        match resolution.to_bundle_relative(&git_cfg.bundle_subdir) {
            Some(local) => {
                log_resolution(&local);
                notices.push(SyncNotice::from_resolution(&local));
            }
            None => log_resolution(resolution),
        }
    }
    let files = git::diff_name_status(repo_root, "ORIG_HEAD..HEAD")
        .map(|entries| entries.len())
        .unwrap_or(0);
    eprintln!(
        "sunstone-server: integrated {behind} commits from {upstream} ({files} files changed)"
    );
    Ok(Some(notices))
}

/// §10.6's two always-logged content lines.
fn log_resolution(resolution: &Resolution) {
    match resolution {
        Resolution::Forked { path, fork } => eprintln!(
            "sunstone-server: conflict on {path} — web version forked to {fork}"
        ),
        Resolution::DeletionDropped { path } => {
            eprintln!("sunstone-server: deletion of {path} dropped (modified on origin)")
        }
    }
}

/// §8.3's self-healing exit: `rebase --abort`, then compose the message the
/// caller logs (with the git error text) before retrying next tick. Idempotent —
/// §9's resolution is baked into the replayed commit, so a retry does not re-fork.
fn abort(repo_root: &Path, reason: impl std::fmt::Display) -> String {
    match git::rebase_abort(repo_root) {
        Ok(()) => format!("{reason} — rebase aborted, retrying next tick"),
        // Worth its own wording: the repo is left mid-rebase, and the next tick's
        // `rebase` will refuse rather than silently do the wrong thing.
        Err(e) => format!("{reason} — and `rebase --abort` failed too: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;

    use sunstone_native::git::CommitIdentity;

    use crate::config::{join_bundle_subdir, GitConfig};

    // --- §10.6's transition reporting, pure over `SyncState` ------------------

    #[test]
    fn a_fresh_state_is_optimistic_and_has_no_age() {
        // A plain / git-local deployment must not report a failure it never had,
        // and `null` (not `0`) says "no tick has completed".
        let status = SyncState::new().snapshot(Shape::Plain);
        assert!(status.last_fetch_ok);
        assert!(status.last_push_ok);
        assert_eq!(status.pending_commits, 0);
        assert_eq!(status.last_sync_age_secs, None);
        assert_eq!(status.shape, Shape::Plain);
    }

    #[test]
    fn a_fetch_failure_logs_once_then_stays_silent_until_recovery() {
        let sync = SyncState::new();
        // The first failure of a streak is the one that logs — with git's text.
        assert!(sync.note_fetch(false), "the first failure is a transition");
        assert!(!sync.snapshot(Shape::GitSynced).last_fetch_ok);
        // Every identical repeat is silent: at a 10s interval this is the
        // difference between one line and ~8,600 a day.
        assert!(!sync.note_fetch(false));
        assert!(!sync.note_fetch(false));
        // Recovery logs exactly once, then silence again.
        assert!(sync.note_fetch(true), "recovery is a transition");
        assert!(!sync.note_fetch(true));
        assert!(sync.snapshot(Shape::GitSynced).last_fetch_ok);
    }

    #[test]
    fn a_push_failure_streak_counts_its_attempts_and_recovers_once() {
        let sync = SyncState::new();
        assert!(sync.note_push(false));
        assert_eq!(sync.push_attempts(), 1);
        assert!(!sync.note_push(false));
        assert!(!sync.note_push(false));
        assert_eq!(sync.push_attempts(), 3);
        assert!(!sync.snapshot(Shape::GitSynced).last_push_ok);

        // The recovery line reads the streak length: `push recovered after 3
        // attempts`, which is why the counter survives the transition.
        assert!(sync.note_push(true));
        assert_eq!(sync.push_attempts(), 3);
        assert!(sync.snapshot(Shape::GitSynced).last_push_ok);
        assert!(!sync.note_push(true), "a healthy push says nothing");

        // A later streak starts counting from one again.
        assert!(sync.note_push(false));
        assert_eq!(sync.push_attempts(), 1);
    }

    #[test]
    fn an_identical_tick_error_is_logged_once_until_a_tick_completes() {
        let sync = SyncState::new();
        assert!(sync.note_tick_error("git rev-list --count failed: boom"));
        assert!(!sync.note_tick_error("git rev-list --count failed: boom"));
        // A *different* anomaly is its own first occurrence.
        assert!(sync.note_tick_error("something else"));
        // A completed tick clears the memo, so a recurrence after a healthy
        // stretch is heard again.
        sync.note_tick(0);
        assert!(sync.note_tick_error("something else"));
    }

    #[test]
    fn note_tick_records_the_pending_count_and_stamps_the_age() {
        let sync = SyncState::new();
        sync.note_tick(7);
        let status = sync.snapshot(Shape::GitSynced);
        assert_eq!(status.pending_commits, 7);
        assert_eq!(status.last_sync_age_secs, Some(0));
    }

    #[test]
    fn the_age_is_whole_seconds_since_the_last_completed_tick() {
        let now = Instant::now();
        assert_eq!(age_secs(None, now), None);
        assert_eq!(age_secs(Some(now), now), Some(0));
        // Truncated to whole seconds, never rounded up.
        assert_eq!(age_secs(Some(now), now + Duration::from_millis(1_900)), Some(1));
        assert_eq!(age_secs(Some(now), now + Duration::from_secs(12)), Some(12));
        // A clock that appears to go backwards saturates instead of panicking.
        assert_eq!(age_secs(Some(now + Duration::from_secs(5)), now), Some(0));
    }

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

    // --- §8.1's coalescing ---------------------------------------------------

    #[tokio::test]
    async fn n_kicks_during_one_tick_coalesce_into_one_follow_up() {
        let sync = SyncState::new();
        // A save-storm while a tick is in flight: `Notify` holds at most one
        // permit, so the loop runs exactly ONE follow-up sync, not five.
        for _ in 0..5 {
            sync.kick();
        }
        tokio::time::timeout(Duration::from_millis(50), sync.notify.notified())
            .await
            .expect("the stored permit wakes the loop immediately");
        assert!(
            tokio::time::timeout(Duration::from_millis(50), sync.notify.notified())
                .await
                .is_err(),
            "the five kicks collapsed into one wake-up"
        );
    }

    // --- Live-git ticks over real temp repos with a local bare remote, skipped
    // cleanly when `git` is absent (the convention in git.rs / conflict.rs). --

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    fn git(root: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?} failed: {out:?}");
    }

    fn stdout(root: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?} failed: {out:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "sunstone-sync-{tag}-{}-{}",
            std::process::id(),
            n
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn put(root: &Path, rel: &str, bytes: &[u8]) {
        let abs = root.join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(abs, bytes).unwrap();
    }

    fn read(root: &Path, rel: &str) -> Vec<u8> {
        std::fs::read(root.join(rel)).unwrap_or_else(|e| panic!("reading {rel}: {e}"))
    }

    /// Identity and signing come from the repo, never the ambient `~/.gitconfig`.
    fn local_identity(root: &Path) {
        git(root, &["config", "user.email", "test@example.com"]);
        git(root, &["config", "user.name", "Test User"]);
        git(root, &["config", "commit.gpgsign", "false"]);
    }

    fn commit_all(root: &Path, msg: &str, date: Option<&str>) {
        git(root, &["add", "-A"]);
        match date {
            Some(date) => git(root, &["commit", "-q", "-m", msg, "--date", date]),
            None => git(root, &["commit", "-q", "-m", msg]),
        }
    }

    fn head(root: &Path) -> String {
        stdout(root, &["rev-parse", "HEAD"])
    }

    /// The whole deployment in three directories: a bare remote, a second clone
    /// standing in for **origin-side** actors (another container, a laptop), and
    /// `repo` — the one under test, as `/srv/repo` would be.
    struct Deployment {
        /// The bare repo's path, doubling as the `SUNSTONE_GIT_ORIGIN` string.
        bare: PathBuf,
        origin: String,
        other: PathBuf,
        repo: PathBuf,
    }

    /// Seed a bare remote on `main` with `seed`, then clone it twice.
    fn deployment(tag: &str, seed: impl Fn(&Path)) -> Deployment {
        let bare = temp_dir(&format!("{tag}-bare"));
        git(&bare, &["init", "--bare", "-q", "--initial-branch=main"]);
        let origin = bare.to_string_lossy().into_owned();

        let other = temp_dir(&format!("{tag}-other"));
        git(&other, &["init", "-q", "--initial-branch=main"]);
        local_identity(&other);
        seed(&other);
        commit_all(&other, "base", None);
        git(&other, &["remote", "add", "origin", &origin]);
        git(&other, &["push", "-q", "origin", "main"]);

        let parent = temp_dir(&format!("{tag}-parent"));
        let repo = parent.join("repo");
        git(&parent, &["clone", "-q", "--branch", "main", "--", &origin, "repo"]);
        local_identity(&repo);

        Deployment {
            bare,
            origin,
            other,
            repo,
        }
    }

    /// A git-synced [`Config`] over `repo_root`, exactly as `config::parse_env`
    /// would produce it for `SUNSTONE_GIT_BRANCH=main` + an origin.
    fn synced_cfg(repo_root: &Path, origin: &str, subdir: &str) -> Config {
        Config {
            shape: Shape::GitSynced,
            git: Some(GitConfig {
                branch: "main".to_string(),
                origin: Some(origin.to_string()),
                bundle_subdir: subdir.to_string(),
                sync_interval: Duration::from_secs(10),
                sync_identity: CommitIdentity {
                    name: "Sunstone Sync".to_string(),
                    email: "sync@sunstone.invalid".to_string(),
                },
                ssh_key_pem: None,
                known_hosts: None,
            }),
            repo_root: Some(repo_root.to_path_buf()),
            bundle_root: join_bundle_subdir(repo_root, subdir),
            seed_from: None,
            jwt_secret: None,
            api_port: crate::DEFAULT_PORT,
            warnings: Vec::new(),
        }
    }

    /// An origin-side push from the `other` clone.
    fn push_from_other(d: &Deployment, edit: impl Fn(&Path), msg: &str) {
        edit(&d.other);
        commit_all(&d.other, msg, None);
        git(&d.other, &["push", "-q", "origin", "main"]);
    }

    fn base_note(root: &Path) {
        put(root, "notes/f.md", b"base\n");
    }

    const WEB_DATE: &str = "2026-07-26T10:15:00+00:00";
    const WEB_TS: &str = "20260726T101500Z";
    /// Deliberately not valid UTF-8: the fork is written **verbatim**.
    const WEB_BYTES: &[u8] = b"web version\n\xff\xfe\x80 tail\n";

    #[test]
    fn a_no_op_tick_is_silent_and_touches_nothing() {
        if !git_available() {
            return;
        }
        let d = deployment("noop", base_note);
        let cfg = synced_cfg(&d.repo, &d.origin, "");
        let sync = SyncState::new();
        let before = head(&d.repo);

        let notices = tick(&cfg, &d.repo, &sync).unwrap();

        assert!(notices.is_empty(), "the common case says nothing");
        assert_eq!(head(&d.repo), before, "HEAD untouched");
        assert_eq!(stdout(&d.repo, &["status", "--porcelain"]), "");
        assert!(stdout(&d.repo, &["stash", "list"]).is_empty(), "never stash");
        let status = sync.snapshot(Shape::GitSynced);
        assert!(status.last_fetch_ok && status.last_push_ok);
        assert_eq!(status.pending_commits, 0);
        // The tick *completed*, so the age is fresh even though nothing happened.
        assert_eq!(status.last_sync_age_secs, Some(0));
    }

    #[test]
    fn an_outbound_only_tick_pushes_and_clears_the_pending_count() {
        if !git_available() {
            return;
        }
        let d = deployment("outbound", base_note);
        let cfg = synced_cfg(&d.repo, &d.origin, "");
        let sync = SyncState::new();

        // A web save: one commit that exists only in this container.
        put(&d.repo, "notes/g.md", b"web\n");
        commit_all(&d.repo, "create notes/g.md via web", None);
        let ours = head(&d.repo);
        assert_eq!(
            git::rev_list_count(&d.repo, "origin/main..HEAD").unwrap(),
            1
        );

        let notices = tick(&cfg, &d.repo, &sync).unwrap();

        assert!(notices.is_empty(), "an ordinary push is not user-facing");
        assert_eq!(head(&d.repo), ours, "no rebase was needed");
        // It really landed on origin, fast-forward.
        assert_eq!(stdout(&d.bare, &["rev-parse", "main"]), ours);
        let status = sync.snapshot(Shape::GitSynced);
        assert_eq!(status.pending_commits, 0, "nothing is web-only any more");
        assert!(status.last_push_ok);
    }

    #[test]
    fn an_inbound_only_tick_rebases_the_change_into_the_working_tree() {
        if !git_available() {
            return;
        }
        let d = deployment("inbound", base_note);
        let cfg = synced_cfg(&d.repo, &d.origin, "");
        let sync = SyncState::new();
        push_from_other(&d, |r| put(r, "notes/h.md", b"from origin\n"), "origin edit");

        let notices = tick(&cfg, &d.repo, &sync).unwrap();

        // Inbound content is NOT broadcast by the loop (§10.1) — it reaches
        // clients as an ordinary unstamped watcher change.
        assert!(notices.is_empty());
        assert_eq!(read(&d.repo, "notes/h.md"), b"from origin\n");
        assert_eq!(head(&d.repo), stdout(&d.bare, &["rev-parse", "main"]));
        assert_eq!(sync.snapshot(Shape::GitSynced).pending_commits, 0);
    }

    #[test]
    fn a_genuine_conflict_forks_the_web_copy_and_emits_one_notice() {
        if !git_available() {
            return;
        }
        let d = deployment("conflict", base_note);
        let cfg = synced_cfg(&d.repo, &d.origin, "");
        let sync = SyncState::new();

        push_from_other(&d, |r| put(r, "notes/f.md", b"origin version\n"), "origin edit");
        // The web save, with a fixed author date so §9's `<ts>` is deterministic.
        put(&d.repo, "notes/f.md", WEB_BYTES);
        commit_all(&d.repo, "edit notes/f.md via web", Some(WEB_DATE));

        let notices = tick(&cfg, &d.repo, &sync).unwrap();

        // Exactly one notice, from the resolution record (§9.4), bundle-relative.
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].kind, SyncNoticeKind::Forked);
        assert_eq!(notices[0].path, "notes/f.md");
        let fork = format!("notes/f-{WEB_TS}.md");
        assert_eq!(notices[0].fork.as_deref(), Some(fork.as_str()));

        // origin keeps the name; the web bytes survive verbatim beside it.
        assert_eq!(read(&d.repo, "notes/f.md"), b"origin version\n");
        assert_eq!(read(&d.repo, &fork), WEB_BYTES);
        // The fork is committed and pushed, not left dangling in the worktree.
        assert!(stdout(&d.repo, &["ls-files", "notes/"]).contains(&fork));
        assert_eq!(stdout(&d.repo, &["status", "--porcelain"]), "");
        assert_eq!(
            stdout(&d.bare, &["rev-parse", "main"]),
            head(&d.repo)
        );
        assert_eq!(sync.snapshot(Shape::GitSynced).pending_commits, 0);
    }

    #[test]
    fn a_conflict_outside_the_bundle_is_resolved_without_a_notice() {
        if !git_available() {
            return;
        }
        // A subdir Bundle: `/srv/repo/docs` is the Bundle, `README.md` is not in
        // it — but a rebase covers the whole repo, so both must be resolved.
        let d = deployment("subdir", |r| {
            put(r, "docs/notes/f.md", b"base\n");
            put(r, "README.md", b"base\n");
        });
        let cfg = synced_cfg(&d.repo, &d.origin, "docs");
        let sync = SyncState::new();

        push_from_other(
            &d,
            |r| {
                put(r, "docs/notes/f.md", b"origin version\n");
                put(r, "README.md", b"origin readme\n");
            },
            "origin edit",
        );
        put(&d.repo, "docs/notes/f.md", WEB_BYTES);
        put(&d.repo, "README.md", b"web readme\n");
        commit_all(&d.repo, "edit via web", Some(WEB_DATE));

        let notices = tick(&cfg, &d.repo, &sync).unwrap();

        // Both conflicts resolved (otherwise `--continue` would have refused)…
        assert_eq!(read(&d.repo, "docs/notes/f.md"), b"origin version\n");
        assert_eq!(read(&d.repo, &format!("docs/notes/f-{WEB_TS}.md")), WEB_BYTES);
        assert_eq!(read(&d.repo, "README.md"), b"origin readme\n");
        assert_eq!(read(&d.repo, &format!("README-{WEB_TS}.md")), b"web readme\n");
        // …but only the in-Bundle one is worth telling a client about, and its
        // path is bundle-relative, not repo-relative.
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].path, "notes/f.md");
        assert_eq!(
            notices[0].fork.as_deref(),
            Some(format!("notes/f-{WEB_TS}.md").as_str())
        );
    }

    #[test]
    fn a_non_fast_forward_rejection_leaves_everything_intact_for_a_retry() {
        if !git_available() {
            return;
        }
        let d = deployment("reject", base_note);
        let cfg = synced_cfg(&d.repo, &d.origin, "");
        let sync = SyncState::new();

        // Reproduce the fetch→push race deterministically: remap the remote's
        // fetch refspec so `fetch origin main` writes FETCH_HEAD only and leaves
        // `refs/remotes/origin/main` frozen at the clone point. The tick then
        // believes it is only ahead — exactly the state a real origin advancing
        // between our fetch and our push puts it in.
        git(
            &d.repo,
            &["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/frozen/*"],
        );
        push_from_other(&d, |r| put(r, "notes/h.md", b"from origin\n"), "origin edit");
        put(&d.repo, "notes/g.md", b"web\n");
        commit_all(&d.repo, "create notes/g.md via web", None);

        let ours = head(&d.repo);
        let origin_before = stdout(&d.bare, &["rev-parse", "main"]);
        let notices = tick(&cfg, &d.repo, &sync).unwrap();

        assert!(notices.is_empty(), "a rejection is never user-facing");
        assert_eq!(head(&d.repo), ours, "no history was rewritten");
        assert_eq!(
            stdout(&d.bare, &["rev-parse", "main"]),
            origin_before,
            "origin is untouched — never force-push"
        );
        let status = sync.snapshot(Shape::GitSynced);
        // The commit is still web-only, which is the number to alert on…
        assert_eq!(status.pending_commits, 1);
        // …and the expected race is not reported as a transport failure.
        assert!(status.last_push_ok);
        // Nothing recorded a push failure, so *this* call is the first of a new
        // streak — proof the tick did not open (and log) one for the race.
        assert!(sync.note_push(false), "the rejection opened no failure streak");
    }

    #[test]
    fn a_dirty_working_tree_skips_the_tick_without_being_modified() {
        if !git_available() {
            return;
        }
        let d = deployment("dirty", base_note);
        let cfg = synced_cfg(&d.repo, &d.origin, "");
        let sync = SyncState::new();
        push_from_other(&d, |r| put(r, "notes/h.md", b"from origin\n"), "origin edit");

        // An in-flight edit: uncommitted, and worth more than a prompt sync.
        put(&d.repo, "notes/f.md", b"in flight\n");
        let before = head(&d.repo);

        let notices = tick(&cfg, &d.repo, &sync).unwrap();

        assert!(notices.is_empty());
        assert_eq!(
            read(&d.repo, "notes/f.md"),
            b"in flight\n",
            "never stash, never reset --hard, never clean"
        );
        assert_eq!(head(&d.repo), before, "the rebase never started");
        assert!(stdout(&d.repo, &["stash", "list"]).is_empty());
        // Inbound work was NOT integrated, so the next tick retries it.
        assert!(!d.repo.join("notes/h.md").exists());
        assert!(!stdout(&d.repo, &["status", "--porcelain"]).is_empty());
        // A skipped tick is not a completed one: the age keeps growing, which is
        // the operator's signal that syncing is stalled.
        assert_eq!(sync.snapshot(Shape::GitSynced).last_sync_age_secs, None);
    }

    /// §10.6: the refusal is the one repeating condition that used to log
    /// unconditionally — at the 10s default that is ~8,600 identical lines/day.
    #[test]
    fn a_persistently_dirty_tree_logs_once_rather_than_once_per_tick() {
        if !git_available() {
            return;
        }
        let d = deployment("dirty-dedupe", base_note);
        let cfg = synced_cfg(&d.repo, &d.origin, "");
        let sync = SyncState::new();
        push_from_other(&d, |r| put(r, "notes/h.md", b"from origin\n"), "origin edit");
        put(&d.repo, "notes/f.md", b"in flight\n");

        tick(&cfg, &d.repo, &sync).unwrap();
        let first = sync.lock().last_error.clone();
        assert!(
            first.as_deref().is_some_and(|m| m.contains("refused")),
            "the refusal goes through the dedupe recorder, not a bare eprintln!: {first:?}"
        );

        tick(&cfg, &d.repo, &sync).unwrap();
        assert_eq!(
            sync.lock().last_error,
            first,
            "the same tree refuses identically"
        );
        assert!(
            !sync.note_tick_error(first.as_deref().unwrap()),
            "so the second tick logged nothing"
        );
    }

    /// The resolve loop is bounded on **progress**, not effort. A fixed ceiling
    /// (64) turned §9.1's *designed-for* case into a permanent stall: every tick
    /// aborted the rebase, `pendingCommits` climbed, and nothing recovered.
    #[test]
    fn more_conflicting_commits_than_the_old_fixed_cap_still_converge() {
        if !git_available() {
            return;
        }
        let d = deployment("many-stops", base_note);
        let cfg = synced_cfg(&d.repo, &d.origin, "");
        let sync = SyncState::new();

        push_from_other(
            &d,
            |r| put(r, "notes/f.md", b"origin version\n"),
            "origin edit",
        );

        // An offline stretch: N commits touching one path, each of which
        // re-conflicts, so the rebase stops N times. N is above the old cap.
        const N: usize = 70;
        for i in 0..N {
            put(&d.repo, "notes/f.md", format!("web version {i}\n").as_bytes());
            commit_all(&d.repo, &format!("web edit {i}"), Some(WEB_DATE));
        }

        let notices = tick(&cfg, &d.repo, &sync).unwrap();

        // Converged, and coalesced to ONE fork holding the FINAL content (§9.1).
        let fork = format!("notes/f-{WEB_TS}.md");
        assert_eq!(
            read(&d.repo, &fork),
            format!("web version {}\n", N - 1).as_bytes(),
            "the fork carries the final content, not an intermediate draft"
        );
        assert_eq!(read(&d.repo, "notes/f.md"), b"origin version\n");
        assert_eq!(
            notices
                .iter()
                .filter(|n| n.kind == SyncNoticeKind::Forked)
                .count(),
            1,
            "one fork per path per run, so one notice"
        );
        assert_eq!(stdout(&d.repo, &["status", "--porcelain"]), "");
        assert_eq!(sync.snapshot(Shape::GitSynced).pending_commits, 0);
    }

    #[test]
    fn a_fetch_failure_returns_early_and_records_the_streak() {
        if !git_available() {
            return;
        }
        let d = deployment("offline", base_note);
        let cfg = synced_cfg(&d.repo, &d.origin, "");
        let sync = SyncState::new();
        git(
            &d.repo,
            &["remote", "set-url", "origin", "/nonexistent/sunstone-not-a-repo"],
        );
        put(&d.repo, "notes/g.md", b"web\n");
        commit_all(&d.repo, "create notes/g.md via web", None);
        let before = head(&d.repo);

        assert!(tick(&cfg, &d.repo, &sync).unwrap().is_empty());

        let status = sync.snapshot(Shape::GitSynced);
        assert!(!status.last_fetch_ok);
        assert_eq!(status.last_sync_age_secs, None, "no tick completed");
        assert_eq!(head(&d.repo), before, "offline is not destructive");
        // The transition was already recorded, so the next identical failure is
        // silent — and a recovery logs exactly once.
        assert!(!sync.note_fetch(false));
        assert!(sync.note_fetch(true));
    }

    /// The whole loop, once: `spawn` → the immediate first tick under the write
    /// lock → the notice on the event channel as a `Sync` variant. Also the proof
    /// that the loop broadcasts **only** notices: the inbound rewrite of
    /// `notes/f.md` arrives at clients through the watcher, not from here.
    #[tokio::test]
    async fn the_spawned_loop_ticks_and_broadcasts_only_its_notices() {
        if !git_available() {
            return;
        }
        let d = deployment("loop", base_note);
        push_from_other(&d, |r| put(r, "notes/f.md", b"origin version\n"), "origin edit");
        put(&d.repo, "notes/f.md", WEB_BYTES);
        commit_all(&d.repo, "edit notes/f.md via web", Some(WEB_DATE));

        let cfg = synced_cfg(&d.repo, &d.origin, "");
        let (events, mut rx) = tokio::sync::broadcast::channel::<ServerEvent>(8);
        let state = Arc::new(ServerState {
            app: Arc::new(sunstone_native::app_state::AppState::new(
                cfg.bundle_root.clone(),
            )),
            events,
            write_lock: Mutex::new(()),
            jwt_secret: None,
            cfg,
            sync: SyncState::new(),
        });

        let handle = spawn(state.clone());
        let event = tokio::time::timeout(Duration::from_secs(20), rx.recv())
            .await
            .expect("the loop's first tick is immediate")
            .expect("an event");
        handle.abort();

        let ServerEvent::Sync(notice) = event else {
            panic!("the loop broadcasts nothing but notices");
        };
        assert_eq!(notice.kind, SyncNoticeKind::Forked);
        assert_eq!(notice.path, "notes/f.md");
        // The tick really ran: the push landed and the status route has an age.
        assert_eq!(stdout(&d.bare, &["rev-parse", "main"]), head(&d.repo));
        assert!(state.sync.snapshot(Shape::GitSynced).last_sync_age_secs.is_some());
    }

    #[test]
    fn a_tick_without_a_git_config_is_an_error_rather_than_a_panic() {
        let cfg = Config::plain(std::env::temp_dir());
        let err = tick(&cfg, &std::env::temp_dir(), &SyncState::new()).unwrap_err();
        assert!(err.contains("no git configuration"), "got {err:?}");
    }
}
