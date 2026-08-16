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
  `src/lib/ipc/`. All backend access goes through the `Backend` interface; both
  `tauri.ts` (real) and `fake.ts` (in-memory) must implement every method.
- **Pure logic lives in plain `.ts`** (e.g. `path.ts`, `treeNav.ts`,
  `frontmatter.ts`, `appHotkeys.ts`, `propertiesEdits.ts`, `quickNavResults.ts`)
  so it can be unit-tested; `.svelte`/`.svelte.ts` files stay thin over those
  helpers. When component logic grows, extract it this way (precedents:
  `tileEditorMenu.ts`, `treeCrud.ts`, `editor/mermaidRender.ts`).
- **Paths crossing the seam** are bundle-relative, forward-slash.
- Commit messages end with: `🤖 Generated with claude-code`.
