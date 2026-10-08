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
- **Reserved filenames** ([§3.1](/okf/spec.md#31-reserved-filenames)) have defined meaning at any level and are **not** Concepts: `index.md` (a progressive-disclosure directory listing, [§8](/okf/spec.md#8-index-files)) and `log.md` (a dated change history, [§9](/okf/spec.md#9-log-files)). Every other `.md` is a Concept.
- **Bundle-absolute links** (`/tables/orders.md`) are resolved relative to the **bundle root** ([§6.1](/okf/spec.md#61-links-between-concepts)).
- Consumers **MAY synthesize** an `index.md`, a tag view, or a graph on the fly; the format mandates no tooling ([§8](/okf/spec.md#8-index-files), [§3.1](/okf/spec.md#31-reserved-filenames)).

A Bundle is [conformant](/okf/spec.md#11-conformance) if every non-reserved `.md` parses its frontmatter and carries a non-empty `type`, and reserved files follow their structure. Everything else is soft guidance — missing indexes, broken links, and unknown fields must never make a consumer reject the Bundle.

## How Sunstone treats a Bundle

`sunstone ./docs` opens a folder as an editable Bundle. Sunstone is both a **consumer** (viewer/traversal) and a **producer** (editor/writer) of the Bundle, and it leans on the spec's permissive consumption model in both roles.

### Finding the bundle root (Sunstone extension)

The spec assumes you already know the bundle root; Sunstone often does **not**, because the folder it is pointed at is frequently a repository whose Bundle lives under `docs/`, while bundle-absolute links (`/x.md`) were authored relative to _that_ inner root. `find_bundle_root(all_paths, okf_markers)` in [`sunstone-shared`](/architecture/sunstone-shared.md) (`crates/sunstone-shared/src/bundle_root.rs`) finds it in rungs, first match wins. The frontend runs that same code through the wasm seam rather than a TS twin ([ADR 0006](/adr/0006-wasm-shared-core-for-frontend-logic.md)).

**Rung 1: the `okf_version` marker.** v0.2 [§12](/okf/spec.md#12-versioning) lets a bundle-root `index.md` declare `okf_version`, the only Frontmatter a Reserved file may carry. So an `index.md` that declares it is a positive root declaration, and it outranks every structural rule below (a top-level `README.md` included). When several declare it along one ancestor chain, the **outermost** wins; an inner declaration is a nested Bundle, not the root. Declarations in unrelated sibling directories are ambiguous, so the finder does not guess between them and falls through to rung 2. The value must be a non-empty string (`"0.2"`) or an unquoted number (`0.2`). Anything else (an empty value, a list, unparseable YAML, no Frontmatter) counts as no marker.

The finder stays pure: it never reads a file. The markers reach it as data. `Index::okf_markers()` (desktop and server) and the fake's store each parse every `index.md` with the shared `frontmatter::okf_version_of` and hand the list out as `Backend.listOkfMarkers()`. The frontend's `indexStore` passes it to the wasm `BundleIndex` beside the path list, and the handle reports the root (`bundleRoot()`) and the version it declares (`okfVersion()`, `null` when the root was inferred).

A missing marker proves nothing. Upstream issue #26 reports the reference agent's index regeneration silently dropping `okf_version`, so absence falls through to rung 2 rather than meaning "no Bundle".

**Sunstone writes the marker too.** Sunstone is a producer as well as a consumer, so a Bundle it creates declares itself. **New Bundle…** (in the launcher and the Bundle switcher, beside **Open folder…**) picks a folder, makes its root `index.md` declare `okf_version: "0.2"`, and opens it, so the Bundle roots on rung 1 from then on. The writer is `okf_marker::declare_okf_version` in `sunstone-shared` (natively via `bundle::declare_okf_bundle`, in the fake via wasm):

- no root `index.md`: one is written with the marker and a `# <folder>` heading;
- a root `index.md` without the key: `okf_version` becomes the first Frontmatter line (a block is prepended when there is none); every other key and the body stay byte-for-byte;
- a root `index.md` that already has an `okf_version` key, whatever version it names, or whose Frontmatter does not parse: left alone, never upgraded.

Only the root `index.md` is written; no other `index.md` ever gains Frontmatter. Merely opening a folder (**Open folder…**, `sunstone ./notes`) writes nothing: OKF behaviour is gated on the marker ([ADR 0009](/adr/0009-marker-gated-okf-language-service.md)), so writing it on open would turn every folder of notes into an OKF Bundle. Sunstone Web has no launcher, so `createBundle` is desktop-only.

**Rung 2: structural inference**, from the path list alone:

1. Any top-level `.md` (a root `index.md` or root-level Concept) ⇒ the opened folder **is** the root. A Bundle at the opened root is the common case; never redirect down.
2. Otherwise, the shallowest directory carrying an `index.md`; on a depth tie prefer the canonical `docs/`, else only commit when a single candidate is shallowest.
3. No `index.md` anywhere ⇒ the sole shared top-level segment if every Concept has one, else `''` (don't guess).

`apply_bundle_root` then prepends that root to a bundle-absolute target **only when the rewritten path actually exists**, so a mis-identified root can never mis-navigate a link that would otherwise have worked. This is the one bundle-level rule Sunstone _adds_ to the spec — see [Linking → Nested bundle root](/okf/linking.md#nested-bundle-root).

### Indexes Sunstone synthesizes

Per [§8](/okf/spec.md#8-index-files), a consumer may synthesize views the Bundle doesn't ship. Sunstone builds several at load time and keeps them live under the file watcher:

| Index | Powers | Where |
| --- | --- | --- |
| Path set | broken-link styling, `apply_bundle_root` existence checks | frontend index store (mirrors the Rust path list) |
| Name → path | [Wikilink](/GLOSSARY.md) resolution, rename-rewrite | `sunstone-shared/src/wikilink.rs` (native **and** wasm) |
| Backlinks | the **Backlinks** [Section](/GLOSSARY.md) | `Index::backlinks(path)` in `sunstone-native/src/index.rs`, over the `sunstone-shared` link/wikilink kernels |
| Tags | the **Tags** [Section](/GLOSSARY.md) (hidden when the Bundle has none) | server/backend frontmatter scan |

The link/backlink logic is implemented **once**, in [sunstone-shared](/architecture/sunstone-shared.md), and compiled to both native and wasm, so the desktop backend, web renderer, and Playwright fake cannot drift ([ADR 0006](/adr/0006-wasm-shared-core-for-frontend-logic.md)). See [Linking → the pure-logic seam](/okf/linking.md#the-pure-logic-seam).

### Reserved files

`index.md` and `log.md` are recognised as reserved and treated as **not Concepts**: they are exempt from the required-`type` check and are kept out of the Explorer's ordinary leaves. **Deviation:** the spec says index files carry no frontmatter (the sole exception being a bundle-root `index.md`'s `okf_version`), but Sunstone tolerates and uses it — a folder's `index.md` `title` names that folder in the Explorer and Tile header — so the [Frontmatter Region](/okf/concept.md#frontmatter) shows for reserved files as for any Concept. Hiding it would leave that `title` in effect but invisible. The one Frontmatter key the spec does sanction there, the root `index.md`'s `okf_version`, shows in that same Region and is the only key Sunstone itself ever writes into an `index.md` (see "Sunstone writes the marker too" above).

### The Bundle is git-committed content

Sunstone leans into the spec's "git repository (recommended)" distribution: the Bundle _is_ the tracked working tree, and the **web write path commits edits straight back into it**. `crates/sunstone-native/src/git/` (`commit.rs`) stages bundle-relative paths and either creates a fresh `edit … via web` commit (`commit`) or folds an anchor-relink write into the preceding one (`amend`, `--no-edit`, preserving author + author-date — only while that commit is unpushed). Author == committer, set via `GIT_*` env so the commit is independent of any repo-level `user.name` — except under the **git-synced** deployment shape, where the sync loop is the *committer* of a replayed commit while the OIDC user stays its author ([ADR 0007](/adr/0007-server-owns-the-git-sync-loop.md)). See [Testing](/architecture/testing.md) for the write flow and its test strategy, and `docker/README.md` at the repo root for the three web deployment shapes.

### What is _not_ part of the Bundle

Per-user UI state — last-open Concept, expanded folders, sidebar flags, window geometry — is **View state**, held per user (desktop: OS config dir; web: the browser) and **never written into the Bundle**. The code names it after the Bundle (`BundleState`, `/_api/bundle-state`), a flagged misnomer sharpened now that the Bundle is the git-committed content the web write path commits. See the [Glossary note](/GLOSSARY.md#flagged-ambiguities).

## Where Sunstone deviates from the pure spec

| Topic | Pure OKF | Sunstone |
| --- | --- | --- |
| Bundle root | Known a priori; absolute links resolve from it | Taken from the outermost `index.md` declaring `okf_version` ([§12](/okf/spec.md#12-versioning)); without one, **inferred** structurally. Either way, the rewrite is existence-gated ([Linking](/okf/linking.md#nested-bundle-root)) |
| Link forms | Standard markdown links only ([§6](/okf/spec.md#6-cross-linking-and-paths)) | Adds name-based **[Wikilinks](/GLOSSARY.md)** as an optional secondary form ([ADR 0004](/adr/0004-wikilinks-optional-secondary-name-based.md)) |
| Indexes | Consumer _may_ synthesize | Always synthesizes path/name/backlink/tag indexes, kept live under the watcher |
| Distribution | git is _recommended_ | git is **operationalised** — the web editor commits into the Bundle repo (`git/`) |
| `okf_version` | May be declared in root `index.md` | Read from **any** `index.md` as a root declaration (the outermost wins, so an inner one marks a nested Bundle); not required, and its absence is no evidence there is no Bundle. **New Bundle…** writes it into the root `index.md` (`"0.2"`), never over an existing declaration |

## Related

- [Concept](/okf/concept.md) — the per-file unit inside a Bundle, and how Sunstone edits one.
- [OKF Specification](/okf/spec.md) — the vendored spec, §2–§3, §6, §8–§9, §11.
- [Linking](/okf/linking.md) — bundle root detection, the name/path resolution seam, backlinks, rewrite-on-move.
- [Glossary](/GLOSSARY.md) — **Bundle**, **Reserved file**, **View state**.
- [Testing](/architecture/testing.md) — the git-write path over a Bundle and its test strategy.
- [Architecture](/architecture/index.md) — the packages (core/server/desktop/web) that implement this Bundle handling.
