---
type: Package
title: sunstone-native — the shared domain crate
description: The host-agnostic Rust crate holding all Bundle logic — filesystem, index, links, rewrite, search, render, git, watcher, config — reused verbatim by both the desktop shell and the web server.
resource: crates/sunstone-native
tags: [architecture, rust, crate, core, domain]
timestamp: 2026-07-23T00:00:00Z
---

# sunstone-native

`crates/sunstone-native/` is Sunstone's **host-agnostic IO/backend logic** — everything about operating on a [Bundle](/okf/bundle.md) (a folder of markdown [Concepts](/okf/concept.md)) that must behave identically whether the host is the [desktop shell](/architecture/desktop-shell.md) or the [web server](/architecture/sunstone-server.md). Nothing here depends on `tauri`, `axum`, or any UI framework: the crate is library logic plus two thin seams to the OS — the filesystem and the `git` binary.

It builds on [sunstone-shared](/architecture/sunstone-shared.md): the **pure** algorithms (link/wikilink/slug resolution, anchor rewrite, frontmatter parse, outline/CriticMarkup/citation scanners, pure paths) live there and are compiled to both native and wasm, so `sunstone-native` **re-points its call sites** into `sunstone_shared::*` rather than owning a native-only copy. What stays here is the machinery that only makes sense on the host — the filesystem, the in-memory index, the watcher, search, git, config, and the `comrak` HTML render.

This is the native hub of the whole system. The desktop shell and the server depend on it by path and add only a thin transport layer on top; see the [overview](/architecture/overview.md) for the shape of that relationship.

## Public surface

`src/lib.rs` is just a module manifest declaring the public modules; each is one area of Bundle behaviour:

| Module | Responsibility |
| --- | --- |
| `bundle` | Filesystem operations over the Bundle — tree walk (`list_tree`), Concept read/write, CRUD, and the path resolvers `resolve` / `resolve_new`. Returns `TreeNode`. |
| `paths` | Native path/walk helpers so tree/index/search cannot drift — the canonical `bundle_walker` (`.gitignore`-aware); the pure string/link math (`to_rel_string`, `resolve_internal`, `is_external`) is delegated to [sunstone-shared](/architecture/sunstone-shared.md). |
| `index` | The in-memory Bundle index — forward map (path → type/tags/keys/links) and reverse backlink map, kept current incrementally. Query methods back the tags, backlinks, types and keys features; the frontmatter/link parse kernels come from `sunstone-shared`. Returns `TagCount`. |
| `rewrite` | IO orchestration for automatic link rewriting on Concept/folder rename+move and heading-anchor rename — the pure planning core (`rewrite_anchors_in`, path math) lives in `sunstone-shared`; this module walks the corpus and applies it. Returns `RewriteSummary`. |
| `search` | On-demand full-text body search via the **ripgrep libraries** (`grep-searcher`/`grep-regex`, no external `rg` binary). Returns `SearchHit`s. |
| `render` | Server-side markdown → read-only HTML via `comrak`, with resolved links, outline, CriticMarkup and citations — the outline/critic/citation scanners are the **same** `sunstone-shared` kernels the browser runs. Returns `RenderPayload`. |
| `watcher` | `notify`-based recursive filesystem watcher that keeps the index current and delivers non-self changes to a caller-supplied **sink** callback. Returns `FileChange`. |
| `git` | Minimal seam over the system `git` binary — read side (`file_history`, `file_at_rev`) for both hosts, write side (`commit`, `amend`) used only by the server. |
| `config` | Global config/session store in the OS app-data dir (**never inside the Bundle**) — known bundles, per-Bundle `BundleState`, `WindowState`. |
| `app_state` | `AppState`: the shared runtime handle — canonical `bundle_root`, `RwLock<Index>`, and the self-write tracker the watcher consults. |

The pure `links`, `wikilink`, `slug`, `frontmatter`-parse, `outline`, `critic`, `citations` and `url` logic no longer lives here — it moved to [sunstone-shared](/architecture/sunstone-shared.md) so one source serves native, SSR, and the browser wasm at once ([ADR 0006](/adr/0006-wasm-shared-core-for-frontend-logic.md)).

## Data across the boundary

The types the hosts serialize out to the frontend are the crate's contract. Almost all are `serde` structs with `rename_all = "camelCase"` so they match the TypeScript types on the other side of the [IPC seam](/architecture/web-frontend.md#the-ipc-seam): `TreeNode`, `TagCount`, `SearchHit`, `RenderPayload` (+ `FrontmatterField`, `OutlineHeading`), `RewriteSummary` / `AnchorRename`, `FileChange` (+ `FileOrigin`, `FileAuthor`), the `git` history/revision enums, and the `config` state structs. `AppState` is the one non-serialized type — hosts hold it behind an `Arc`.

## Design constraints

These are the invariants the rest of the system relies on:

- **Bundle-relative, forward-slash paths at every seam.** `''` is the root; Windows backslashes never cross the boundary. Conversion goes through `to_rel_string`.
- **Path-escape hardening.** `bundle::resolve` / `resolve_new` reject `..`, absolute paths, and symlink escapes (canonicalize + containment check) — the security boundary for both the local IPC and the [server's genuine network edge](/architecture/sunstone-server.md).
- **No external binaries except `git`.** Search uses the ripgrep _libraries_; the only subprocess is the system `git`, and its absence is a first-class value (`GitMissing` / `NotARepo`), never a panic.
- **Single source of truth for traversal and link logic.** One `bundle_walker` shared by tree/index/search; markdown + wikilink resolution lives once in [sunstone-shared](/architecture/sunstone-shared.md).
- **No TS twin of the pure logic.** The frontend no longer reimplements link/frontmatter/render-derived algorithms in TypeScript; it runs `sunstone-shared` compiled to wasm, so the browser's broken-link decoration and the Rust index execute the *same* code by construction, not a hand-kept mirror ([ADR 0006](/adr/0006-wasm-shared-core-for-frontend-logic.md)).
- **Config never written into the Bundle** (no `.obsidian` equivalent); losing it is harmless (missing/corrupt → defaults).
- **Broken links and invalid frontmatter are tolerated, never blocking** — parsers return defaults rather than erroring, per the [OKF handling](/okf/linking.md).
- **Pure/IO split for testability.** The rewrite engine, anchor scanner, path math, and `render_body` are pure and exhaustively unit-tested; IO stays thin in the `bundle` / `git` seams. See [Testing](/architecture/testing.md).

## Relationships

- Depends on [sunstone-shared](/architecture/sunstone-shared.md) for its pure algorithms; consumed verbatim by the [desktop shell](/architecture/desktop-shell.md) (thin Tauri commands) and the [web server](/architecture/sunstone-server.md) (thin axum handlers) — the [overview](/architecture/overview.md) diagrams both paths.
- Its serde types are the shapes the [web frontend](/architecture/web-frontend.md) mirrors in `src/lib/types.ts`.
- The git-write side underpins the [Bundle](/okf/bundle.md) commit model; anchor/link rewriting realizes the [Linking](/okf/linking.md) model.
