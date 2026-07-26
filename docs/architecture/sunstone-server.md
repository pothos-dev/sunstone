---
type: Package
title: sunstone-server — the Sunstone Web HTTP backend
description: The axum binary that exposes one Bundle over sunstone-native as a JSON/SSE API — open reads, JWT-gated git-backed writes, and the git sync loop — for the server-rendered web viewer.
resource: crates/sunstone-server
tags: [architecture, rust, axum, server, web, http, git-sync]
timestamp: 2026-07-26T00:00:00Z
---

# sunstone-server

`crates/sunstone-server/` is the backend of **Sunstone Web**: a thin **axum** HTTP binary that exposes a single [Bundle](/okf/bundle.md) over the shared [sunstone-native](/architecture/sunstone-native.md) crate — the exact bundle/index/render/git logic the [desktop shell](/architecture/desktop-shell.md) uses. Reads are open; an authenticated, git-backed **write path** is gated behind a verified JWT. All filesystem access is validated by sunstone-native against the canonical Bundle root, so path-escape attempts are rejected at what is now a genuine network boundary. It is also the owner of the **git sync loop**: in the git-synced [deployment shape](#deployment-shapes) this same process fetches, rebases and pushes, so web edits and external `git push`es reconcile continuously ([ADR 0007](/adr/0007-server-owns-the-git-sync-loop.md)).

The server exposes only a JSON/SSE API — it serves **no** static assets. The public origin and all HTML belong to the SvelteKit SSR process ([web frontend](/architecture/web-frontend.md)), which proxies `/api/*` to this binary. See the [overview](/architecture/overview.md) for the full two-process web topology.

## Files

| File | Role |
| --- | --- |
| `src/main.rs` | Entrypoint, `ServerState`, the axum router, all HTTP handlers, SSE wiring, error classification, bundle-root resolution. |
| `src/config.rs` | One **pure** `parse(get) -> Result<Config, Vec<ConfigError>>` over an injected getter — the whole env surface, git and pre-existing alike, read once at boot and stored in `ServerState`. Every problem is reported at once. |
| `src/boot.rs` | The ordered boot sequence: ssh material, the optional seed copy, the clone/adopt/`init` state machine at `/srv/repo`, bundle-root resolution, and the two writability preflights. Every failure exits non-zero with an actionable message. |
| `src/sync.rs` | The sync loop (git-synced only) plus its two surfaces: the named `sync` SSE notice and `GET /api/sync-status`. |
| `src/conflict.rs` | The conflict resolver — the one uniform fork rule, and the `path → fork` map that coalesces a rebase run to one fork per path. |
| `src/auth.rs` | Hand-rolled HS256 JWT mint/verify and the `AuthedUser` axum extractor that gates every write route and the two history reads. |
| `src/write.rs` | Write orchestration: composes sunstone-native writers + a git commit per op, decides amend-vs-fresh-commit, produces the SSE change groups to broadcast, and (in a git shape) signals the sync loop. |

## HTTP routes

All under `/api`. Reads are open GETs; writes require a verified JWT and return `204 No Content` unless noted.

**Reads:** `GET /api/bundle-root`, `/api/tree` (`TreeNode`), `/api/concept?path=` (raw markdown), `/api/render?path=` (`RenderPayload`), `/api/search?q=`, `/api/backlinks?path=`, `/api/tags`, `/api/concepts-by-tag?tag=`, `/api/types`, `/api/keys`, `/api/concept-paths`, `/api/concept-exists?path=`, and `GET /api/events` — the **SSE** stream (`text/event-stream`) carrying `FileChange` events for live reload plus, under the named `sync` event, the two [sync notices](#the-sync-loop-git-synced-only).

**Gated reads (JWT, same gate as writes):** `GET /api/history?path=` (`FileHistory`) and `GET /api/file-at-rev?path=&rev=` (`FileAtRev`) — the review-diff surface. Gated because `fileAtRev` returns the full text of any path at any revision, so unguarded it would republish every version of every file ever committed, including content deliberately **deleted** from the Bundle. `hooks.server.ts` therefore treats these two pathnames as a `GATED_READS` set, taking the session→mint→forward branch even though the method is GET; the frontend maps `401` to `gitMissing`, so an anonymous client simply sees the toggle disabled. In the **plain** shape the handlers **short-circuit to `notARepo` without spawning git** — load-bearing, because git's upward repo discovery would otherwise let a Bundle bind-mounted inside a host repo serve *that* repo's log.

**Operator read (unauthenticated):** `GET /api/sync-status` → `{shape, lastFetchOk, lastPushOk, pendingCommits, lastSyncAgeSecs}`. **Content-free by rule** — no error strings, no remote URL, no branch name — which is what makes it safe to leave open and usable from a monitoring probe without minting a token. `pendingCommits` is how much web work exists only inside this container. No UI consumes it; it is explicitly **not** a healthcheck.

**Writes (JWT-gated):** `PUT /api/concept` (overwrite body → commit `edit … via web`), `POST /api/concept` (create), `DELETE /api/concept?path=` (delete), `POST /api/folder` (create dir — no commit, git has no empty dirs — but broadcasts a `created`), `POST /api/rename` and `POST /api/move` (+ auto link-rewrite → `RewriteSummary`, one commit), `POST /api/rewrite-anchors` (→ `RewriteSummary`). In the **plain** shape a write skips git entirely; in a git shape it commits and then signals the sync loop.

Errors map through classifiers: reads → 400 (path escape) / 404; writes → 400 / 409 (conflict) / 404 / 500; auth failure short-circuits to a bare 401 in the extractor.

## Using sunstone-native

`ServerState` wraps `Arc<AppState>` — the same canonical-root-plus-in-memory-`Index` type the desktop uses, built on startup. Reads call core directly (`bundle`, `render`, `search`, and the `Index` query methods) under a shared `RwLock` read guard. Writes (`write.rs`) compose the commitless core writers (`bundle`, `rewrite`) then commit via the core `git` primitive (`git::commit` / `git::amend`, `CommitIdentity`). The core watcher runs on startup with a sink that fans each `FileChange` into a `tokio::sync::broadcast` channel; `note_self_write` mutes the watcher's own echo so the server broadcasts one `origin`-stamped event instead. **The server is the sole git committer** — the desktop never commits.

## Auth

The trust model is **reads open, writes gated**. There is no session logic in Rust:

- The SvelteKit `/api` hook resolves the Auth.js session and, only if valid, mints a short-lived (60s) **HS256 JWT** and forwards it as `Authorization: Bearer` (plus the per-tab `x-sunstone-client` header).
- `auth::verify` verifies the token itself with pure-Rust `hmac`/`sha2`/`base64` — constant-time signature check, `alg: HS256` enforced (defeats alg-confusion / "none"), `exp` checked. No JWT crate.
- The `AuthedUser` extractor yields `{name, email}`, which flows straight into the git commit identity. If `SUNSTONE_JWT_SECRET` is unset, **every write route 401s** — a safe read-only default. The Rust `Claims` struct byte-mirrors the Node minter.

## Deployment shapes

The server derives its **shape** from the *presence* of any `SUNSTONE_GIT_*` variable — never from a mode flag, and `SUNSTONE_GIT_BRANCH` (no default) is required as soon as one is present ([ADR 0007](/adr/0007-server-owns-the-git-sync-loop.md)):

| Shape | Env signature | Bundle root | Save does | Loop |
| --- | --- | --- | --- | --- |
| **plain** | no `SUNSTONE_GIT_*` at all | `SUNSTONE_BUNDLE` | write the file, **no git** | — |
| **git-local** | `SUNSTONE_GIT_BRANCH` only | `/srv/repo[/<subdir>]` | commit locally | — |
| **git-synced** | branch + `SUNSTONE_GIT_ORIGIN` + key | `/srv/repo[/<subdir>]` | commit | fetch → rebase → push |

**plain** is a real feature, not the absence of one: `write.rs` commits unconditionally today, so a non-repo Bundle would 500 on Save. Its read-side half is the history short-circuit above.

## The sync loop (git-synced only)

A tokio task, spawned only in the git-synced shape, waiting on a `tokio::sync::Notify` **with a timeout** of `SUNSTONE_GIT_SYNC_INTERVAL_SECS` and taking the **same `write_lock`** the write path takes — one owner, so the reconcile lock over both directions is an ordinary in-process mutex, with no `.git/index.lock` races and no cross-process flock ([ADR 0007](/adr/0007-server-owns-the-git-sync-loop.md)).

One tick: `fetch`, then — if behind — `rebase -Xno-renames origin/<branch>` with a scripted file-level resolver on every stop, then a **fast-forward-only** `push`. A conflicted path takes origin's side while the web bytes fork verbatim to `foo-<ts>.md` beside it (at most one fork per path per run); the two user-visible outcomes, *fork created* and *web deletion dropped*, are pushed as a named `sync` SSE event and rendered as a dismissible notice. Everything else the loop does reaches clients through the ordinary watcher path — it broadcasts nothing itself and never calls `note_self_write`. A Save signals the loop **after** releasing the lock, so outbound latency is immediate and the interval governs inbound discovery only. The loop is offline-tolerant and never force-pushes, `stash`es, `reset --hard`s or `clean`s.

The container paths it needs (`/srv/repo` for the clone, `/srv/ssh` for the key and `known_hosts`) are **constants**, and they stay out of `sunstone-native`: `git.rs` is host-agnostic and shared with the desktop, so the server sets a process-global `git::configure(GitEnv)` once at boot (`GIT_SSH_COMMAND`, the sync committer identity, `commit.gpgsign=false`). The desktop never calls it, so its behaviour is unchanged.

## Launch

`#[tokio::main] async fn main()`, strictly ordered: parse the whole env surface once via `config::parse` (**any** malformed git value ⇒ print *every* `ConfigError` and exit non-zero); write the ssh material and call `git::configure`; run the optional `SUNSTONE_BUNDLE_SEED_FROM` copy; clone/adopt/`init` the repo at `/srv/repo`; resolve the Bundle root (git shapes: the clone plus `SUNSTONE_GIT_BUNDLE_SUBDIR`; plain: `SUNSTONE_BUNDLE`, else a dev `examples/` fallback); run two writability preflights (a git shape ⇒ the repo is writable; `SUNSTONE_JWT_SECRET` set ⇒ the Bundle is writable, probed by create-then-remove, never by comparing ownership); then as before — build `Arc<AppState>`, start the watcher fanning into a broadcast channel, bind `0.0.0.0:<SUNSTONE_API_PORT || 8787>`, `axum::serve` — and finally spawn the sync loop if the shape is git-synced.

Configuration is entirely via env, with **no CLI args**. The `SUNSTONE_GIT_*` namespace is **closed** (an unrecognised member is a boot error, which catches typos and stale sidecar env files) and every git value is strict, while the pre-existing variables keep their historical leniency; the normative list, with the strict/lenient column and the volumes, is the one table in [`docker/README.md`](../../docker/README.md#environment--volume-reference) — deliberately not repeated here, because a second list is a second thing to forget to update.

Locally, `cargo run -p sunstone-server` serves `examples/` out of the box (plain shape, no git). In production the `Dockerfile` runs this binary as uid 1000 on internal `:8787` alongside the SSR Node server; see `docker/README.md` and the internal-network / no-auth-on-reads caveat.

## Relationships

- Wraps [sunstone-native](/architecture/sunstone-native.md) over HTTP — the server half of the [IPC seam](/architecture/web-frontend.md#the-ipc-seam) (the desktop half is [Tauri commands](/architecture/desktop-shell.md)).
- Fronted by the [web frontend](/architecture/web-frontend.md)'s SSR process, which owns auth and the public origin.
- Realizes the git-commit half of the [Bundle](/okf/bundle.md) write model; the write flow's test strategy is in [Testing](/architecture/testing.md).
- Owns the git sync loop, the rebase-always/fork-on-conflict rules and the presence-gated shapes — [ADR 0007](/adr/0007-server-owns-the-git-sync-loop.md); the deployment recipes and the normative env/volume table live in [`docker/README.md`](../../docker/README.md).
