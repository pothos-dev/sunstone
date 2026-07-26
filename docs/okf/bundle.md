---
type: Concept
title: Bundle — how Sunstone treats an OKF bundle
description: What OKF says a Bundle is, and how Sunstone opens, indexes, roots, and commits one — including where it extends the pure spec.
tags: [okf, bundle, index, backlinks, git, bundle-root]
timestamp: 2026-07-23T00:00:00Z
---

# Bundle

A **[Bundle](/GLOSSARY.md)** is the root folder Sunstone opens — a directory tree of markdown [Concepts](/okf/concept.md), per [OKF](/okf/spec.md). This page pulls the bundle-level rules out of the [spec](/okf/spec.md) and records how Sunstone actually treats a Bundle, including the places it goes beyond the spec.

## What OKF says

From [spec §3](/okf/spec.md#3-bundle-structure) and [§2](/okf/spec.md#2-terminology):

- A Bundle is a **directory tree of markdown files**, organised however the producer likes; the directory layout is independent of the domain.
- It is the **unit of distribution** — shippable as a git repository (recommended, for history/attribution/diffs), a tarball/zip, or a subdirectory within a larger repo.
- **Reserved filenames** ([§3.1](/okf/spec.md#31-reserved-filenames)) have defined meaning at any level and are **not** Concepts: `index.md` (a progressive-disclosure directory listing, [§6](/okf/spec.md#6-index-files)) and `log.md` (a dated change history, [§7](/okf/spec.md#7-log-files-optional)). Every other `.md` is a Concept.
- **Bundle-absolute links** (`/tables/orders.md`) are resolved relative to the **bundle root** ([§5.1](/okf/spec.md#51-absolute-bundle-relative-links)).
- Consumers **MAY synthesize** an `index.md`, a tag view, or a graph on the fly; the format mandates no tooling ([§6](/okf/spec.md#6-index-files), [§3.1](/okf/spec.md#31-reserved-filenames)).

A Bundle is [conformant](/okf/spec.md#9-conformance) if every non-reserved `.md` parses its frontmatter and carries a non-empty `type`, and reserved files follow their structure. Everything else is soft guidance — missing indexes, broken links, and unknown fields must never make a consumer reject the Bundle.

## How Sunstone treats a Bundle

`sunstone ./docs` opens a folder as an editable Bundle. Sunstone is both a **consumer** (viewer/traversal) and a **producer** (editor/writer) of the Bundle, and it leans on the spec's permissive consumption model in both roles.

### Finding the bundle root (Sunstone extension)

The spec assumes you already know the bundle root; Sunstone often does **not**, because the folder it is pointed at is frequently a repository whose Bundle lives under `docs/`, while bundle-absolute links (`/x.md`) were authored relative to _that_ inner root. `findBundleRoot(allPaths)` in `src/lib/links.ts` infers the root **structurally, from paths only** (never frontmatter):

1. Any top-level `.md` (a root `index.md` or root-level Concept) ⇒ the opened folder **is** the root. A Bundle at the opened root is the common case; never redirect down.
2. Otherwise, the shallowest directory carrying an `index.md`; on a depth tie prefer the canonical `docs/`, else only commit when a single candidate is shallowest.
3. No `index.md` anywhere ⇒ the sole shared top-level segment if every Concept has one, else `''` (don't guess).

`applyBundleRoot` then prepends that root to a bundle-absolute target **only when the rewritten path actually exists**, so a mis-identified root can never mis-navigate a link that would otherwise have worked. This is the one bundle-level rule Sunstone _adds_ to the spec — see [Linking → Nested bundle root](/okf/linking.md#nested-bundle-root).

### Indexes Sunstone synthesizes

Per [§6](/okf/spec.md#6-index-files), a consumer may synthesize views the Bundle doesn't ship. Sunstone builds several at load time and keeps them live under the file watcher:

| Index | Powers | Where |
| --- | --- | --- |
| Path set | broken-link styling, `applyBundleRoot` existence checks | frontend index store (mirrors the Rust path list) |
| Name → path | [Wikilink](/GLOSSARY.md) resolution, rename-rewrite | `wikilink.rs` (Rust) + `src/lib/ipc/fake/links.ts` (TS twin) |
| Backlinks | the **Backlinks** [Section](/GLOSSARY.md) | `backlinks(path)` in `src-tauri/src/lib.rs`, from `index/links.rs` + `wikilink.rs` |
| Tags | the **Tags** [Section](/GLOSSARY.md) (hidden when the Bundle has none) | server/backend frontmatter scan |

The link/backlink logic is implemented **twice** — pure Rust and pure TS — kept byte-for-byte identical so the desktop backend, web renderer, and Playwright fake all agree. See [Linking → the pure-logic seam](/okf/linking.md#the-pure-logic-seam).

### Reserved files

`index.md` and `log.md` are recognised as reserved and treated as **not Concepts**: they are exempt from the required-`type` check and show **no Properties panel** (they carry no frontmatter — the sole exception is a bundle-root `index.md`, which may declare `okf_version`). See [Concept → frontmatter](/okf/concept.md#frontmatter) for the panel that this exemption turns off.

### The Bundle is git-committed content

Sunstone leans into the spec's "git repository (recommended)" distribution: the Bundle _is_ the tracked working tree, and the **web write path commits edits straight back into it**. `crates/sunstone-native/src/git.rs` stages bundle-relative paths and either creates a fresh `edit … via web` commit (`commit`) or folds an anchor-relink write into the preceding one (`amend`, `--no-edit`, preserving author + author-date). Author == committer, set via `GIT_*` env so the commit is independent of any repo-level `user.name` — except under the **git-synced** deployment shape, where the sync loop is the *committer* of a replayed commit while the OIDC user stays its author ([ADR 0007](/adr/0007-server-owns-the-git-sync-loop.md)). See [Testing](/architecture/testing.md) for the write flow and its test strategy, and `docker/README.md` at the repo root for the three web deployment shapes.

### What is _not_ part of the Bundle

Per-user UI state — last-open Concept, expanded folders, sidebar flags, window geometry — is **View state**, held per user (desktop: OS config dir; web: the browser) and **never written into the Bundle**. The code names it after the Bundle (`BundleState`, `/api/bundle-state`), a flagged misnomer sharpened now that the Bundle is the git-committed content the web write path commits. See the [Glossary note](/GLOSSARY.md#flagged-ambiguities).

## Where Sunstone deviates from the pure spec

| Topic | Pure OKF | Sunstone |
| --- | --- | --- |
| Bundle root | Known a priori; absolute links resolve from it | **Inferred** via `findBundleRoot`, with a safe existence-gated fallback ([Linking](/okf/linking.md#nested-bundle-root)) |
| Link forms | Standard markdown links only ([§5](/okf/spec.md#5-cross-linking)) | Adds name-based **[Wikilinks](/GLOSSARY.md)** as an optional secondary form ([ADR 0004](/adr/0004-wikilinks-optional-secondary-name-based.md)) |
| Indexes | Consumer _may_ synthesize | Always synthesizes path/name/backlink/tag indexes, kept live under the watcher |
| Distribution | git is _recommended_ | git is **operationalised** — the web editor commits into the Bundle repo (`git.rs`) |
| `okf_version` | May be declared in root `index.md` | Recognised on the root `index.md` only; not required |

## Related

- [Concept](/okf/concept.md) — the per-file unit inside a Bundle, and how Sunstone edits one.
- [OKF Specification](/okf/spec.md) — the vendored spec, §2–§3, §6–§7, §9.
- [Linking](/okf/linking.md) — bundle root detection, the name/path resolution seam, backlinks, rewrite-on-move.
- [Glossary](/GLOSSARY.md) — **Bundle**, **Reserved file**, **View state**.
- [Testing](/architecture/testing.md) — the git-write path over a Bundle and its test strategy.
- [Architecture](/architecture/index.md) — the packages (core/server/desktop/web) that implement this Bundle handling.
