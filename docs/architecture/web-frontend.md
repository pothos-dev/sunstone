---
type: Package
title: Web frontend — the SvelteKit + Svelte 5 UI
description: The SvelteKit (Svelte 5 runes) app under src/ — one codebase that serves both the desktop SPA and the server-rendered web viewer, decoupled from the backend by the IPC seam.
resource: src
tags: [architecture, sveltekit, svelte, frontend, ipc, web]
timestamp: 2026-07-23T00:00:00Z
---

# Web frontend (`src/`)

The SvelteKit app (Svelte 5 runes) at the repo root under `src/` is the "web" package — but it is really **one frontend that targets two hosts**: the [desktop shell](/architecture/desktop-shell.md) (a static SPA in a Tauri window) and Sunstone Web (server-rendered against [sunstone-server](/architecture/sunstone-server.md)). A single compile-time flag and a backend-selection seam keep the two builds from forking the code.

## The IPC seam

`src/lib/ipc/` is the single boundary between the frontend and any backend. `@tauri-apps/api` is imported **only** inside this directory; all app code imports `{ backend }` from `$lib/ipc` and nothing else.

| File | Role |
| --- | --- |
| `backend.ts` | The `Backend` interface — ~40 async methods (`listTree`, `readConcept`, `writeConcept`, `onFileChanged`, CRUD, index queries, `search`, git seam, `renderConcept`, print/PDF, state). Paths crossing it are always bundle-relative, forward-slash. |
| `tauri.ts` | Real desktop backend — a thin `invoke(...)` / `listen(...)` per method; command names match the [desktop shell](/architecture/desktop-shell.md)'s `#[tauri::command]`s. |
| `http.ts` | Web backend — `fetch` to relative `/api/...` against [sunstone-server](/architecture/sunstone-server.md); open GET reads, JWT-gated `PUT/POST/DELETE` writes carrying a per-tab `x-sunstone-client` id, live updates via `EventSource('/api/events')`. |
| `fake.ts` (+ `fake/*`) | In-memory backend over a seeded fixture Bundle — behaviourally faithful (same path conventions, path-escape rejection, simulated watcher, canned git history). Powers plain-Chromium dev and the desktop Playwright suite. |
| `index.ts` | **Backend selection:** `backend = __SUNSTONE_WEB__ ? httpBackend : isTauri ? tauriBackend : fakeBackend`. `__SUNSTONE_WEB__` is a Vite `define` constant, so the unused branches are dead-code-eliminated. |

Every method both real backends implement returns one of the [sunstone-core](/architecture/sunstone-core.md) serde shapes, mirrored in `src/lib/types.ts`.

## One codebase, two builds

The whole thing pivots on `SUNSTONE_TARGET=web` → the compile-time boolean `__SUNSTONE_WEB__`:

- **`svelte.config.js`** picks the adapter: web → `@sveltejs/adapter-node` (SSR on, served by a Node process behind the `/api` proxy); default/desktop → `@sveltejs/adapter-static` SPA (`fallback: index.html`), since Tauri has no Node server.
- **`vite.config.js`** defines `__SUNSTONE_WEB__` and adds a `sunstoneWebStubs()` resolver that, in the web build only, swaps desktop-only imports for inert stubs (`tauri-stub.ts`, `AppStub.svelte`, `DesktopShellStub.svelte`) — keeping `@tauri-apps/api` and CodeMirror out of the web/SSR graph.
- **`src/hooks.server.ts`** (web only) is the same-origin `/api/*` proxy: GET/HEAD forward unchanged; writes resolve the Auth.js session, mint the HS256 JWT (`src/lib/server/jwt.ts`), and forward it as `Authorization: Bearer` to `SUNSTONE_API_INTERNAL`; SSE streams through un-buffered. This is where auth lives — the [server](/architecture/sunstone-server.md) only verifies.
- **`src/lib/PageShell.svelte`** is the fork point every route renders: `?print=` → `PrintView`; `data.web === true` → `WebViewer`; else → `DesktopShell` (which shows the Launcher or the full `App.svelte` editor).

## Layout of `src/`

- **`src/routes/`** — thin SvelteKit routes: `+page`/`[...concept]` catch-all mapping pretty URLs to Concepts; `+layout.ts` gates SSR on `__SUNSTONE_WEB__`. All delegate to `PageShell`.
- **`src/lib/ipc/`** — the seam (above).
- **`src/lib/web/`** — the web-specific layer: `WebViewer` (SSR read-only shell) and its sidebar pieces; `WebAppShellIsland` (authenticated users dynamically `import()` the full `App.svelte`, keeping CodeMirror out of SSR, and host the write-concurrency coordinator); `WebEditorIsland` (in-place single-Tile editor); `WebConcurrencyModals` (shared conflict / leave / structural-op UX); plus pure helpers `loadConcept.ts`, `conceptUrl.ts`, `concurrency.ts`, `uiState.ts`.
- **`src/lib/editor/`** — CodeMirror internals (see the [editor cluster](/editor/index.md)): `cm.ts`, wikilinks, broken-links, anchor-tracking, citations, CriticMarkup, find, formatting, mermaid.
- **`src/lib/state/`** — Svelte 5 runes state singletons (`.svelte.ts`): `editor`, `workspace`, `document`, `bundle`, `index`, `theme`, `treeActions`, `focus`, and layout/nav helpers.
- **`src/lib/components/`** — desktop components (`Tile`, `TileHeader`, `Tree`, `ActivityRail`, `SidebarEdge`, `Outline`, `Backlinks`, `Properties*`, `SearchPanel`, `QuickNav`, `Launcher`, …) — the [interface](/interface/index.md) surfaces.
- **Pure logic modules** — plain `.ts` with unit tests beside them, per the repo convention that pure logic stays testable: `path.ts`, `treeNav.ts`, `frontmatter.ts`, `outline.ts`, `highlight.ts`, `slug.ts`, `links.ts`, `citations.ts`, `anchorRewrite.ts`, `fuzzy.ts`, and more. These mirror the [sunstone-core](/architecture/sunstone-core.md) Rust logic exactly so both sides agree.

## Relationships

- Talks to a backend only through the [IPC seam](#the-ipc-seam): [desktop shell](/architecture/desktop-shell.md) commands (`tauri.ts`) or [sunstone-server](/architecture/sunstone-server.md) HTTP (`http.ts`).
- Its pure `.ts` modules mirror [sunstone-core](/architecture/sunstone-core.md); shared types live in `types.ts`.
- Renders the [interface](/interface/index.md) and [editor](/editor/index.md) surfaces documented elsewhere.
- Split across the desktop and web Playwright suites in [Testing](/architecture/testing.md); the [overview](/architecture/overview.md) shows how both builds compose.
