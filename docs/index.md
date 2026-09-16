---
okf_version: "0.2"
---

# Sunstone documentation

Sunstone is a CLI-launched Tauri 2 + SvelteKit + Rust markdown editor with first-class
Open Knowledge Format support. This Bundle is its documentation: the domain language, the
format it reads and writes, the packages that implement it, and the decisions behind them.

## Start here

- [Glossary](GLOSSARY.md) - The canonical domain language for Sunstone — the terms to use and the synonyms to avoid.
- [Architecture](architecture/) - The packages and how they interact: a pure Rust core compiled to native and wasm, the native IO crate, the Tauri shell, the HTTP server, and the SvelteKit frontend.

## The format

- [OKF](okf/) - The format Sunstone reads and writes, plus where Sunstone's handling differs from the pure spec.

## The application

- [Editor](editor/) - How Sunstone's markdown editor is built on CodeMirror 6 — the integration, its patch, and Sunstone's own extensions.
- [Interface](interface/) - Layout, focus, and persisted view state: the app shell, the control surfaces, the Sidebars, and what survives a relaunch.

## Decisions and work

- [Architecture decisions](adr/) - The numbered ADRs recording why Sunstone is built the way it is.
- [Tickets](tickets/) - Planned and in-flight work, grouped by effort.
