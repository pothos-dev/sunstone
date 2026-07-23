---
type: Package
title: Desktop shell — the Tauri 2 wrapper (src-tauri)
description: The src-tauri crate — a thin Tauri 2 wrapper that exposes sunstone-native over IPC commands, resolves the CLI-launched Bundle, watches the filesystem, and drives native PDF export.
resource: src-tauri
tags: [architecture, rust, tauri, desktop, ipc]
timestamp: 2026-07-23T00:00:00Z
---

# Desktop shell (`src-tauri`)

`src-tauri/` is the crate `sunstone` (lib name `sunstone_lib`) — the **Tauri 2 desktop shell**. Its Cargo manifest states the design plainly: _"the desktop shell is now a thin Tauri wrapper over [sunstone-native]."_ All domain logic (bundle I/O, index, git, rewrite, search, render, config, watcher) lives in [sunstone-native](/architecture/sunstone-native.md); the shell only wires it to Tauri IPC, windows, the CLI, and platform PDF APIs. It is the "rust" package a `sunstone ./docs` invocation launches.

## Responsibilities

- Parse the CLI and decide whether to open a Bundle at startup or show the launcher.
- Own a runtime-swappable `Session` — the seam between launcher mode and an open Bundle.
- Expose the `#[tauri::command]` functions the [web frontend](/architecture/web-frontend.md) calls through `src/lib/ipc/tauri.ts`, each delegating to sunstone-native.
- Run the filesystem watcher and emit change events to the frontend.
- Persist window geometry (Rust-owned) and per-Bundle [view state](/interface/view-state.md).
- Manage the separate print window and perform platform-native direct PDF export.

## Files

| File | Role |
| --- | --- |
| `src/main.rs` | 4-line binary entry point; sets the Windows subsystem in release and calls `sunstone_lib::run()`. |
| `src/lib.rs` | The heart of the shell: all IPC command definitions, print-window and PDF-export machinery, startup-bundle resolution, `--detached` re-spawn, window-geometry capture, and the `tauri::Builder` setup (`run()`). |
| `src/session.rs` | `Session`: the current `AppState` and its `WatcherHandle` behind mutexes. `open()` builds the index, starts a fresh watcher (dropping the old), records the folder in config, and restores window geometry. |
| `src/cli.rs` | Hand-rolled arg parser (no clap): `CliAction` (`Run`/`Version`/`Help`/`Error`), `RunOptions { bundle, detached }`. |
| `tauri.conf.json` | Product config: single frameless 1200×800 window, frontend served from `../build` (the SvelteKit static SPA). |
| `capabilities/default.json` | Tauri capability/permission grants. |

## IPC commands

The frontend's real backend (`tauri.ts`) is a thin `invoke(...)` over these; command names match one-to-one. All Bundle-scoped commands read the open Bundle through `session.current()?`, so they error with "no Bundle is open" in launcher mode.

- **Launcher / session** — `bundle_root`, `current_bundle` (drives launcher-vs-editor), `list_known_bundles`, `forget_bundle`, `open_bundle` (canonicalize + `Session::open`), `pick_folder` (native chooser).
- **Tree / Concept CRUD** — `list_tree`, `read_concept`, `write_concept` (autosave; records a self-write so the watcher suppresses its echo), `create_concept`, `create_folder`, `rename_path` / `move_path` (+ auto link-rewrite → `RewriteSummary`), `delete_path`, `rewrite_anchors`.
- **Index queries** — `list_concept_paths`, `concept_exists`, `backlinks`, `all_tags`, `concepts_by_tag`, `all_types`, `all_keys`.
- **Search / git / render** — `search`, `file_history`, `file_at_rev`, `render_concept` (feeds the print/PDF path).
- **Print / PDF** — `open_print_window`, `save_pdf`.
- **Persisted state** — `load_bundle_state` / `save_bundle_state`.

Each command is glue: it delegates straight to the matching sunstone-native function (`bundle`, `index`, `rewrite`, `search`, `git`, `render`, `config`) and re-exports the core serde type. The shell contributes no domain logic of its own.

## Launch model

`run()` calls `cli::parse_args(...)` **before** starting Tauri, so `--version` / `--help` print and exit without a window and bad flags are rejected. The startup Bundle is resolved by `resolve_startup_bundle`: the `SUNSTONE_BUNDLE` env var if set, else the positional CLI path, canonicalized; with neither, the frontend shows the [Launcher](/interface/app-shell.md). `--detached` re-spawns the executable as a console-independent child (a `SUNSTONE_DETACHED_CHILD` marker stops it detaching twice) so the shell prompt returns immediately.

## Print / PDF export

`open_print_window(path)` opens a **separate** native window (label `print`, 900×1100) loading the same SPA at `index.html?print=<path>&toolbar=1`; the frontend resolves that to a `PrintView`. `save_pdf` prompts with the native save chooser, then `export_webview_pdf` — `#[cfg]`-gated per platform through Tauri's `with_webview`:

- **Linux (tested path):** `webkit2gtk` `PrintOperation` with a "print to file" PDF `PrintSettings`, no dialog.
- **macOS (best-effort):** `WKWebView.createPDFWithConfiguration:` (objc2), block writes the `NSData`.
- **Windows (best-effort):** WebView2 `PrintToPdf` straight to a path.
- **Other:** returns "not supported"; the frontend falls back to `window.print()`.

The platform PDF deps are `#[target]`-gated in `Cargo.toml`, pinned to match what `wry` already resolves.

## Relationships

- Wraps [sunstone-native](/architecture/sunstone-native.md); adds only Tauri transport.
- Its IPC commands are the desktop half of the [IPC seam](/architecture/web-frontend.md#the-ipc-seam); the [web server](/architecture/sunstone-server.md) is the parallel half over HTTP.
- Window geometry and session state persist as [view state](/interface/view-state.md), never into the Bundle.
- The [overview](/architecture/overview.md) shows how the desktop path composes; contrast with the web path.
