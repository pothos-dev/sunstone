# Sunstone — agent guide

Sunstone is a CLI-launched **Tauri 2 + SvelteKit (Svelte 5 runes) + Rust**
markdown editor with first-class Open Knowledge Format (OKF) support. Start here,
then read the deeper docs:

- **`docs/GLOSSARY.md`** — domain language (Bundle, Concept, Wikilink, Region, …).
  Use these terms; avoid the listed synonyms.
- **`docs/okf/`** — the OKF spec (`spec.md`) plus how Sunstone handles a
  [Concept](docs/okf/concept.md) and a [Bundle](docs/okf/bundle.md), incl. spec deviations.
- **`docs/architecture/`** — the four packages (`sunstone-core`, the `src-tauri`
  desktop shell, `sunstone-server`, the SvelteKit web frontend) and how they
  interact; start with [`overview.md`](docs/architecture/overview.md).
- **`docs/adr/`** — architecture decisions.

## Verifying changes

Every change must keep these four gates green:

| Command | Scope |
|---------|-------|
| `bun test src/lib` | Frontend unit tests over the pure `src/lib/**/*.test.ts` modules |
| `bun run check` | Frontend typecheck (`svelte-check`) |
| `cargo test` | Rust unit tests across the workspace (`#[cfg(test)]` in each module) |
| `cargo check` | Rust typecheck |

Playwright is the primary behavioural test for components, split across **two**
suites: a desktop suite (static SPA + fake backend) and a web e2e suite (real
`sunstone-server` + SSR build).

**See [`docs/architecture/testing.md`](docs/architecture/testing.md)** for how to run each gate, both
Playwright suites (including the `/tmp/chromium` sandbox override and CDP mode),
and the web write test strategy.

## Conventions that bite

- **IPC seam**: the frontend never imports `@tauri-apps/api` outside
  `src/lib/ipc/`. All backend access goes through the `Backend` interface;
  `tauri.ts` (desktop), `http.ts` (web) and `fake.ts` (in-memory) must each
  implement every method.
- **Pure logic lives in plain `.ts`** (e.g. `path.ts`, `treeNav.ts`,
  `frontmatter.ts`, `appHotkeys.ts`, `quickNavResults.ts`)
  so it can be unit-tested; `.svelte`/`.svelte.ts` files stay thin over those
  helpers. When component logic grows, extract it this way (precedents:
  `tileEditorMenu.ts`, `treeCrud.ts`, `editor/mermaidRender.ts`,
  `state/sessionState.ts`, `dividerDrag.ts`, `editor/lineSpace.ts`,
  `server/apiProxy.ts`). Big components split into child components the same
  way (`ExplorerPane.svelte`, `Sidebar.svelte`, `TileGrid.svelte` out of
  `App.svelte`; `WebReader.svelte` out of `WebViewer.svelte`). An overlay
  registers with the Escape peel through `useOverlay` (`state/overlay.svelte.ts`),
  not a hand-rolled `$effect`.
- **No TS twins of the Rust algorithms** ([ADR 0006](docs/adr/0006-wasm-shared-core-for-frontend-logic.md)):
  link/code scanning, move/rename and anchor rewrite live in `sunstone-shared`;
  the `fake` backend calls them through `src/lib/wasm/exports.ts`. Fix or extend
  the Rust side (goldens in `cargo test`), then `bun run build:wasm`.
- **Server paths are guarded at the network boundary**: every path a route takes
  goes through `check_rel_path` / `guard_rel_path` (`sunstone-server/src/api_error.rs`),
  which also refuses hidden dot-segments such as `.git/`. New routes must too.
- **Paths crossing the seam** are bundle-relative, forward-slash.
- **Desktop Playwright runs rewrite `docs/assets/*.png`** (screenshot specs) —
  revert them before committing unless refreshing marketing images.
- Commit messages end with: `🤖 Generated with claude-code`.
