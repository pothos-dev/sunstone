# The server owns the git sync loop

`sunstone-server` — not a sidecar container, not a host-side hook — runs the **fetch →
integrate → push loop** that keeps a git-backed [Bundle](/GLOSSARY.md) reconciled with its
remote. The server already is the sole git committer for the web write path
([sunstone-server](/architecture/sunstone-server.md)), so it also fetches, rebases and pushes,
in the same working directory, under the **same in-process write lock**.

Three decisions follow from that ownership and are locked here with it: integration is
**rebase-always** (history stays linear, even through conflicts), a true conflict is resolved
by **forking the web side beside the canonical file** (never blocking, never asking a human),
and git is turned on by the **presence of `SUNSTONE_GIT_*` configuration** rather than by a
mode flag — which yields the three deployment shapes **plain**, **git-local** and
**git-synced**.

> **This supersedes the sidecar recipes.** `docker-compose.gitsync.yml`,
> `docker-compose.git-checkout.yml`, `docker/post-receive.example` and the four-approach
> "Serving a git-backed wiki" comparison in `docker/README.md` are **deleted** by the same
> changeset that lands this ADR. The git-synced shape *with no write secret* is a strictly
> better read-only mirror than any of them: one container instead of two, and live reload that
> actually works.

## Motivating constraint

The reconcile lock must cover **both** directions. An inbound integration rewrites files in the
same working tree that an outbound web Save commits, so the two must never interleave. With one
owner that is an ordinary in-process mutex — no `.git/index.lock` races, no cross-process
flock, no shared lockfile protocol. With a sidecar it is two processes writing one clone,
coordinating only through git's own `index.lock` and retries.

Everything else in this ADR is downstream of accepting that single owner.

## Considered Options

- **Server-owned loop (chosen)** — the existing git writer gains `fetch`/`rebase`/`push`. Costs a
  real server feature: code, tests, and a new image.
- **Sidecar container running the loop** — no Sunstone code at all, but two writers on one clone
  and a weaker locking story; and the sidecars we had did not live-reload (see below).
- **Host-side `post-receive` hook checking out a work-tree** — push-instant and clean, but
  inherently one-directional: it cannot carry a *web* commit back to the remote, which is the
  whole point of a writable wiki.
- **`git-sync`-style symlink-swapping sidecar** — rejected by measurement: it repoints a symlink
  at a fresh worktree per commit, so the watcher stays pinned to the old (soon garbage-collected)
  inode and the API serves 404s until the container is restarted. Its own compose header
  documented the defect.

## Decisions

### 1. The server owns the loop (in-process, one lock)

A tokio task waits on a `tokio::sync::Notify` **with a timeout** of
`SUNSTONE_GIT_SYNC_INTERVAL_SECS`, waking on either. Each tick takes the same write lock the
write path takes.

- **Outbound latency is immediate.** The write path signals the loop *after* releasing the lock,
  so a Save kicks a sync instead of waiting for the next tick. The interval therefore governs
  **inbound discovery only**.
- **Save-storms coalesce by construction** — N signals during one in-flight sync collapse into a
  single follow-up run.
- The loop runs **only** in the git-synced shape. It broadcasts nothing of its own: its in-place
  rewrites reach browsers through the ordinary watcher → SSE path, which already renders them as
  "Updated on disk", the dirty-buffer modal, or a tree refresh.
- **Offline tolerance is by design.** An unreachable remote leaves the wiki serving *and*
  editing; commits queue locally and drain when the remote returns. That is why an unreachable
  remote must never mark the container unhealthy, and why `GET /api/sync-status` is explicitly
  **not** a healthcheck.

### 2. Integration is rebase-always — linear history, even through conflicts

Every tick: `git fetch`, then `git rebase -Xno-renames origin/<branch>`, then a
**fast-forward-only** `git push`. There are no merge commits anywhere in this design.

- **Merge-always was rejected** because `git merge` emits a merge bubble on *every* clean tick
  where both sides moved — everyday noise in a repo that syncs on a 10-second timer.
- **Squash-and-merge was rejected** as *unsafe*, not merely ugly: during a push lag or an offline
  stretch the container accumulates commits from several OIDC users, and squashing stamps one
  author over all of them. Rebase-replay preserves each web commit and its author, which is what
  keeps "the commit author is the signed-in user" true.
- **Rename detection is off** (`-Xno-renames`) so that a rename degrades to delete + add and the
  resolver can work purely by path.
- **Push rejection is normal, and force-push is never an option.** The remote can advance between
  our fetch and our push; the loop simply re-fetches, re-rebases and retries next tick.
- The loop **never** `stash`es, `reset --hard`s or `clean`s. If rebase refuses because the tree is
  dirty, it logs and skips the tick — discarding a tree that may hold an in-flight edit is worse
  than a stalled sync.

The premise that a forked conflict "produces a merge commit anyway" is false under rebase: the
conflict is resolved *in place* while the commit is being replayed, so history stays linear.

### 3. One uniform fork rule for conflicts — nothing ever blocks

For **every** conflicted path `P` the rebase stops on, with no per-case analysis and no
exceptions:

| Aspect | Rule |
| --- | --- |
| **Canonical side** | `P` takes **origin's** side. Stage 2 present → `git checkout --ours P`; stage 2 absent (origin deleted `P`) → `git rm P`. |
| **Web side** | Stage 3 present → write those bytes **verbatim** to `fork(P)` and `git add`. Stage 3 absent (the web deleted `P`) → nothing to preserve; the deletion is **dropped**. |
| **`fork(P)`** | Same directory, suffix before the final extension: `notes/foo.md` → `notes/foo-<ts>.md`. |
| **`<ts>`** | `YYYYMMDDThhmmssZ` UTC, taken from the **author date of the web commit being replayed**. |
| **Coalescing** | A `path → fork` map lives for the whole rebase **run**: the first conflict on `P` mints the name, every later conflicting commit on `P` writes to that same path. |
| **Collision** | If the minted name already exists → append `-2`, `-3`, … |
| **Exceptions** | **None.** Reserved files (`index.md`, `log.md`) fork like anything else. |

Why each part is the way it is:

- **Origin keeps the canonical name** because origin is the shared line every clone and every
  inbound link references. It also buys **idempotence**: in a rebase *ours* **is** the base being
  replayed onto, so staging it leaves the replayed commit with no diff on `P` — the commit reduces
  to an add of the fork, and a rejected push does not re-run the resolver next tick.
- **One fork per path per run.** Every Save is its own commit, so an offline stretch replays *N*
  commits touching `foo.md` and each re-conflicts. The map collapses them to a single fork
  carrying the **final** content, whose git history still holds every author's edit.
- **Verbatim bytes** — no frontmatter key, no body note. The resolver stays a pure git/byte
  operation with no markdown or YAML knowledge, so it cannot corrupt a file and works unchanged
  for a non-`.md` path. Provenance is free: the replayed commit keeps its subject and its OIDC
  author, and stripping `-<ts>` recovers the canonical path.
- **Beside the original**, so the fork's own relative links keep resolving and it sits next to the
  file it must be diffed against. Not a `conflicts/` directory (breaks those links) and not a
  hidden or gitignored path (the Bundle walker is hidden- and gitignore-aware, so the fork would
  vanish from the index and could not be opened at all).
- **The resolver reaches the file directly** — never through the write path's rename/move helpers,
  whose automatic link rewriting would drag the whole Bundle's links onto the fork. Inbound links
  keep pointing at the canonical file; the orphaned fork is tolerated.

The two delete cases **fall out** of the rule rather than being special-cased. *Origin deleted /
web modified*: origin's deletion is honoured and the web edit survives as the fork. *Web deleted
/ origin modified*: origin's file survives and **the web deletion is dropped** — a deletion
carries no content, so nothing is lost but the intent, and origin's concurrent edit is evidence
someone still wants the file. That is the single case where a committed web action does not
survive, so it is one of the two things users are told about.

Users see exactly **two** notices, pushed over a named `sync` event on the existing
`/api/events` SSE stream and rendered **dismissible** in the editor island: *a conflicting copy
was saved as `…`*, and *a deletion was reverted because the file was modified on origin*. They
are worded impersonally and carry no author. Transport failures — a failed fetch or push — are
**never** shown to users: nothing is lost and there is no user action to take. Operators get
`GET /api/sync-status` (content-free: booleans, counts, an age, and the shape) plus quiet stderr
logging — every content change always, transport failures on transition only.

### 4. Git is presence-gated; the shapes are plain / git-local / git-synced

There is **no mode flag**. `SUNSTONE_GIT_MODE` was proposed, never shipped, and is deleted: the
gate is a **prefix scan for any `SUNSTONE_GIT_*` variable**, and `SUNSTONE_GIT_BRANCH` (which has
**no default**) becomes required as soon as one is present.

| Shape | Env signature | Bundle root | Save does | Loop |
| --- | --- | --- | --- | --- |
| **plain** | no `SUNSTONE_GIT_*` at all | `SUNSTONE_BUNDLE` | write the file, **no git** | — |
| **git-local** | `SUNSTONE_GIT_BRANCH` only | `/srv/repo[/<subdir>]` | commit locally | — |
| **git-synced** | branch + `SUNSTONE_GIT_ORIGIN` + key | `/srv/repo[/<subdir>]` | commit | fetch → rebase → push |

- **The required branch is the declaration.** The worry a mode flag existed to answer — that
  mounting a subdirectory of someone's repo silently starts committing — is still answered:
  turning git on takes an explicit branch. Only the *spelling* of the declaration changed, from a
  boolean to a required data value.
- **The namespace is closed.** An unrecognised `SUNSTONE_GIT_*` variable is a boot error. That
  catches a typo'd `SUNSTONE_GIT_ORGIN=…` and — load-bearing — turns a stale sidecar env file
  still carrying `SUNSTONE_GIT_REPO` / `_REF` / `_PERIOD` into a **caught migration** rather than
  a wiki that quietly serves un-synced content.
- **Malformed git config refuses to boot**, with every error reported at once. The honest cost is
  a crash loop under `restart: unless-stopped`; accepted, because the alternative is a wiki that
  serves perfectly, commits nothing, and accumulates edits in a volume classed as a disposable
  cache — silent data loss one typo away.
- **`VAR=` (empty) means unset, uniformly.** This is already the repo's idiom, and it makes a
  blank line in an env file mean "default". Its trap is documented rather than fixed: an empty
  `SUNSTONE_GIT_ORIGIN` silently downgrades git-synced to git-local, which is why confirming
  `GET /api/sync-status` after a deploy is the prescribed check.
- **The one log-and-ignore case** is a git shape with `SUNSTONE_BUNDLE` set — the image bakes
  `SUNSTONE_BUNDLE=/bundle` into its ENV, so an operator's override is genuinely
  indistinguishable from the default. That draws the line for the whole surface: log-and-ignore
  applies *only* where a value cannot be told apart from an image default; everything else fails.
- **The clone path `/srv/repo` and the ssh directory `/srv/ssh` are constants, not knobs.** Both
  must exist in the image chowned to the runtime user, so an env var's entire expressive range
  would be "the one correct value" or "broken at boot". Fixing them makes the Bundle
  repo-relative (`SUNSTONE_GIT_BUNDLE_SUBDIR`) and therefore contained by construction.
- **The plain shape is a real feature, not the absence of one.** The write path commits
  unconditionally today, so a non-repo Bundle 500s on Save; plain must explicitly skip git. Its
  read-side half is the same rule: the history routes short-circuit to `notARepo` **without
  spawning git**, so a Bundle bind-mounted inside a host repo can never serve *that* repo's log
  over HTTP.

## Consequences

- **Sunstone Web becomes a genuinely collaborative editor.** Web edits and external `git push`es
  are both first-class and reconcile continuously: an outbound Save reaches the remote
  immediately, an inbound push reaches every connected browser within one interval, with no
  restart.
- **One container replaces two.** The sidecar files and the `post-receive` recipe are deleted; the
  git-synced stack (`docker-compose.wiki.yml`, plus `docker/wiki.env.example`) is the only
  git-backed recipe, and `docker/README.md`'s environment table becomes the **normative** surface
  for every variable and volume.
- **`.git` now lives inside the watched tree.** Keeping git metadata out of the served folder was
  the sidecars' design point; it is given up here. The watcher gains a **hidden-component
  filter** — a defect fix against the walker's existing contract, not a new feature — so SSE
  carries no `.git/…` noise. The residual cost is inotify watch descriptors, a few hundred of
  them, which is accepted for ops simplicity.
- **Divergence is carried, not force-healed.** `checkout -f` in the old sidecars force-healed any
  divergence; rebase-always carries a divergent local tree forever. In a read-only deployment
  nothing can commit, so divergence cannot arise; in the writable one, carrying it is the
  intended behaviour.
- **A persistent push failure is the one place data is quietly at risk** — it lives only in a
  volume classed as a disposable cache. `pendingCommits` on `/api/sync-status` is literally how
  much web work exists only in this container, and is the thing to alert on.
- **Mid-rebase churn is accepted.** A rebase replaying N commits writes each path once per commit,
  so clients can see a burst of intermediate content before it converges. The failure mode is a
  redundant notice, never lost data; a loop gate that swallows those events is recorded as a v2
  follow-up, with "users report repeated conflict modals for one tick" as the revisit trigger.
- **Reconciling a fork back into its canonical file is out of scope** — deliberately. Discovery is
  settled (the fork is a normal Concept in the tree, **Search** and **Quick nav**; git holds the
  provenance), and there is no fork listing and no stored notice state in v1. Tooling or UX for
  the merge-back returns as a fresh effort.
- **The desktop is untouched.** It runs no loop, never commits, and never calls the git-env
  configuration hook the server sets at boot; the shared `sunstone-native` `git.rs` stays
  host-agnostic and learns no container paths.
