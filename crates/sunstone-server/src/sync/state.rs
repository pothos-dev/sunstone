//! The sync loop's shared, mutable state.

use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

use tokio::sync::Notify;

use crate::config::Shape;
use crate::sync::SyncStatus;

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
pub(super) struct SyncInner {
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
    pub(super) last_error: Option<String>,
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
    pub(super) fn lock(&self) -> MutexGuard<'_, SyncInner> {
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
    /// **Not called for a fast-forward rejection** — see [`crate::sync::tick`]:
    /// that is an expected race, not a transport verdict.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

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
}
