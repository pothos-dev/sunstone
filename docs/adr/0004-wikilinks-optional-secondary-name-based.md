---
type: Decision
title: "Wikilinks as an optional, name-based secondary link format"
description: "Wikilinks are an optional, secondary link format that resolves by name, beside path-based markdown links."
tags: [adr, decision]
---

# Wikilinks as an optional, name-based secondary link format

Sunstone supports `[[wikilink]]` syntax as an **optional, secondary** link format **in
addition to** standard markdown links, which remain the primary/canonical form. OKF itself does
not use wikilinks (see [ADR-0001](0001-codemirror-hybrid-live-preview.md)); we support them
because Sunstone bundles frequently originate as Obsidian vaults, where `[[ ]]` is the norm.
Markdown links resolve by **path**; wikilinks resolve by **name** — a fundamentally different
model that this ADR introduces deliberately.

The governing design rule is **match Obsidian exactly**, since the links originate there:

- `[[name]]` matches by **filename** (without `.md`), **case-insensitive**, **literal** (no
  slug/space normalization — `[[Live Preview]]` matches `Live Preview.md`, not
  `live-preview.md`). The frontmatter `title` never participates in resolution.
- Duplicate filenames resolve to the **shortest bundle path**, then alphabetically, **silently**
  (ambiguity is not flagged as broken). Partial paths (`[[folder/name]]`) match by path
  **suffix**. `[[name.md]]` is accepted; reserved files are matchable by basename.
- Aliases `[[name|display]]` and heading targets `[[name#heading]]` are supported. Wikilinks
  feed **Backlinks**, get the same broken-link styling as markdown links, and are
  **rename-rewritten** on a basename change (`[[old]]` → `[[new]]`; moves don't break bare
  wikilinks since they resolve by basename anywhere in the bundle).

## Considered Options

- **Name-based, Obsidian-compatible (chosen)** — what authors of the source vaults actually
  wrote; the only model that makes existing `[[ ]]` links resolve as intended.
- **Path-based `[[./x.md]]`** — trivial (reuses the existing `resolveLink` path resolver) but
  nobody writes paths inside wikilinks, so it would not honor real-world content.
- **Slug-normalized matching** (spaces↔hyphens) — more forgiving across the OKF/Obsidian seam,
  but non-Obsidian, makes resolution many-to-one, and makes broken-link detection fuzzy.

## Consequences

- Resolution now has **two distinct models** living side by side: path-based (markdown) and
  name-based (wikilink). A new name→path index is required, in **both** the Rust backend (for
  Backlinks and rename-rewrite) and the TS fake backend (for the editor resolver and tests).
- Rendering reuses atomic-editor's `wikiLinks` extension (previously disabled per ADR-0001) with
  a Sunstone-supplied `resolve`/`onOpen` adapter, contingent on its `resolve()` cache being
  invalidatable on index change; if not, a custom extension replaces it. Either way, broken
  wikilinks are styled to match the existing `cm-broken-link` look.
- Embeds (`![[ ]]`), block references (`#^`), and `[[`-autocomplete are explicitly **out of
  scope** for the initial version.
- A future reader who finds ADR-0001's "we do not use wikiLinks" should read it as scoped to
  OKF's own format; this ADR is the deliberate, additive exception.
