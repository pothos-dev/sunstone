---
type: Package
title: sunstone-server — the Sunstone Web HTTP backend
description: The axum binary that exposes one Bundle over sunstone-native as a JSON/SSE API — open reads, JWT-gated git-backed writes — for the server-rendered web viewer.
resource: crates/sunstone-server
tags: [architecture, rust, axum, server, web, http]
timestamp: 2026-07-23T00:00:00Z
---

# sunstone-server

`crates/sunstone-server/` is the backend of **Sunstone Web**: a thin **axum** HTTP binary that exposes a single [Bundle](/okf/bundle.md) over the shared [sunstone-native](/architecture/sunstone-native.md) crate — the exact bundle/index/render/git logic the [desktop shell](/architecture/desktop-shell.md) uses. Reads are open; an authenticated, git-backed **write path** is gated behind a verified JWT. All filesystem access is validated by sunstone-native against the canonical Bundle root, so path-escape attempts are rejected at what is now a genuine network boundary.

The server exposes only a JSON/SSE API — it serves **no** static assets. The public origin and all HTML belong to the SvelteKit SSR process ([web frontend](/architecture/web-frontend.md)), which proxies `/api/*` to this binary. See the [overview](/architecture/overview.md) for the full two-process web topology.

## Files

| File | Role |
| --- | --- |
| `src/main.rs` | Entrypoint, `ServerState`, the axum router, all HTTP handlers, SSE wiring, error classification, bundle-root resolution. |
| `src/auth.rs` | Hand-rolled HS256 JWT mint/verify and the `AuthedUser` axum extractor that gates every write route. |
| `src/write.rs` | Write orchestration: composes sunstone-native writers + a git commit per op, decides amend-vs-fresh-commit, and produces the SSE change groups to broadcast. |

## HTTP routes

All under `/api`. Reads are open GETs; writes require a verified JWT and return `204 No Content` unless noted.

**Reads:** `GET /api/bundle-root`, `/api/tree` (`TreeNode`), `/api/concept?path=` (raw markdown), `/api/render?path=` (`RenderPayload`), `/api/search?q=`, `/api/backlinks?path=`, `/api/tags`, `/api/concepts-by-tag?tag=`, `/api/types`, `/api/keys`, `/api/concept-paths`, `/api/concept-exists?path=`, and `GET /api/events` — the **SSE** stream (`text/event-stream`) of `FileChange` events for live reload.

**Writes (JWT-gated):** `PUT /api/concept` (overwrite body → commit `edit … via web`), `POST /api/concept` (create), `DELETE /api/concept?path=` (delete), `POST /api/folder` (create dir — no commit, git has no empty dirs — but broadcasts a `created`), `POST /api/rename` and `POST /api/move` (+ auto link-rewrite → `RewriteSummary`, one commit), `POST /api/rewrite-anchors` (→ `RewriteSummary`).

Errors map through classifiers: reads → 400 (path escape) / 404; writes → 400 / 409 (conflict) / 404 / 500; auth failure short-circuits to a bare 401 in the extractor.

## Using sunstone-native

`ServerState` wraps `Arc<AppState>` — the same canonical-root-plus-in-memory-`Index` type the desktop uses, built on startup. Reads call core directly (`bundle`, `render`, `search`, and the `Index` query methods) under a shared `RwLock` read guard. Writes (`write.rs`) compose the commitless core writers (`bundle`, `rewrite`) then commit via the core `git` primitive (`git::commit` / `git::amend`, `CommitIdentity`). The core watcher runs on startup with a sink that fans each `FileChange` into a `tokio::sync::broadcast` channel; `note_self_write` mutes the watcher's own echo so the server broadcasts one `origin`-stamped event instead. **The server is the sole git committer** — the desktop never commits.

## Auth

The trust model is **reads open, writes gated**. There is no session logic in Rust:

- The SvelteKit `/api` hook resolves the Auth.js session and, only if valid, mints a short-lived (60s) **HS256 JWT** and forwards it as `Authorization: Bearer` (plus the per-tab `x-sunstone-client` header).
- `auth::verify` verifies the token itself with pure-Rust `hmac`/`sha2`/`base64` — constant-time signature check, `alg: HS256` enforced (defeats alg-confusion / "none"), `exp` checked. No JWT crate.
- The `AuthedUser` extractor yields `{name, email}`, which flows straight into the git commit identity. If `SUNSTONE_JWT_SECRET` is unset, **every write route 401s** — a safe read-only default. The Rust `Claims` struct byte-mirrors the Node minter.

## Launch

`#[tokio::main] async fn main()`: resolve `SUNSTONE_BUNDLE` (else a dev `examples/` fallback), build `Arc<AppState>`, start the watcher fanning into a broadcast channel, read `SUNSTONE_JWT_SECRET` (absent → writes disabled), bind `0.0.0.0:<SUNSTONE_API_PORT || 8787>`, `axum::serve`. Configuration is entirely via env — no CLI args. Locally, `cargo run -p sunstone-server` serves `examples/` out of the box. In production the `Dockerfile` runs this binary on internal `:8787` alongside the SSR Node server; see `docker/README.md` and the internal-network / no-auth-on-reads caveat.

## Relationships

- Wraps [sunstone-native](/architecture/sunstone-native.md) over HTTP — the server half of the [IPC seam](/architecture/web-frontend.md#the-ipc-seam) (the desktop half is [Tauri commands](/architecture/desktop-shell.md)).
- Fronted by the [web frontend](/architecture/web-frontend.md)'s SSR process, which owns auth and the public origin.
- Realizes the git-commit half of the [Bundle](/okf/bundle.md) write model; the write flow's test strategy is in [Testing](/architecture/testing.md).
