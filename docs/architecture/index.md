# Architecture — packages and how they interact

Sunstone is four packages: one shared Rust domain crate plus three thin layers over it (a Tauri desktop shell, an HTTP server, and a SvelteKit frontend that targets both). Start with the overview, then read each package.

## Concepts

- [Architecture overview](overview.md) - The four packages and how they compose into a desktop app and a web viewer over one shared crate.
- [sunstone-native](sunstone-native.md) - The host-agnostic Rust crate holding all Bundle logic — the hub both hosts depend on.
- [Desktop shell (src-tauri)](desktop-shell.md) - The thin Tauri 2 wrapper exposing core over IPC commands; the "rust" package `sunstone ./docs` launches.
- [sunstone-server](sunstone-server.md) - The axum binary exposing one Bundle over a JSON/SSE API for Sunstone Web.
- [Web frontend (src/)](web-frontend.md) - The SvelteKit UI that serves both the desktop SPA and the server-rendered web viewer, decoupled by the IPC seam.
- [Testing](testing.md) - The four green gates and two Playwright suites, and which package owns which test.

## Related

- [OKF → Bundle](/okf/bundle.md) - The Bundle these packages operate on, and its git-commit model.
- [OKF → Linking](/okf/linking.md) - The link/rewrite model sunstone-native implements.
- [Interface](/interface/index.md) and [Editor](/editor/index.md) - The frontend surfaces built on the web package.
- [Glossary](/GLOSSARY.md) - Canonical domain terms (Bundle, Concept, …).
