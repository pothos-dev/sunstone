---
type: Reference
title: Sunstone Glossary
description: The canonical domain language for Sunstone — the terms to use and the synonyms to avoid.
tags: [glossary, domain, ubiquitous-language]
timestamp: 2026-07-26
---

# Glossary

Sunstone is a lightweight, CLI-launched Tauri + Svelte markdown editor/viewer with
Obsidian-style live editing and first-class support for the Open Knowledge Format
(OKF). `sunstone ./docs` opens a folder as an editable knowledge base.

## Language

**Bundle**:
The root folder opened by Sunstone — a directory tree of markdown files, per the OKF spec. See
[Bundle](/okf/bundle.md) for how Sunstone roots, indexes, and commits one.
_Avoid_: vault, workspace, project (these are other tools' terms).

**Concept**:
A single `.md` file in the Bundle. Carries YAML frontmatter (required `type` field) and a
free-form markdown body. See [Concept](/okf/concept.md) for how Sunstone models both.
_Avoid_: note, document, page (use **Concept** as the canonical term; "document" acceptable casually).

**Wikilink**:
An optional, secondary link format written `[[name]]` (Obsidian-style), supported in addition
to — never replacing — standard markdown links, which remain the primary/canonical format.
`name` is matched by **filename** (without `.md`), case-insensitive, bundle-wide; it never
matches the frontmatter `title`. Duplicate filenames resolve to the shortest bundle path, then
alphabetically (silent — ambiguity is not flagged broken), matching Obsidian. Partial paths
(`[[folder/name]]`) match by path **suffix**. Wikilinks are a Sunstone compatibility affordance
for content authored in Obsidian; OKF itself does not use them. See [Linking](/okf/linking.md) for
the full resolution model and the layered wikilink fallback.
_Avoid_: "internal link" (ambiguous — could mean any in-Bundle link; say **Wikilink** or
**markdown link** specifically).

**Reserved file**:
A file with OKF-defined special meaning: `index.md` (progressive-disclosure listing) and
`log.md` (dated change history). Not ordinary Concepts.

**Frontmatter**:
The leading YAML block (delimited by `---`) on a Concept. Only `type` is required;
`title`, `description`, `resource`, `tags`, `timestamp` are recommended; unknown keys must
be preserved. See [Concept → frontmatter](/okf/concept.md#frontmatter) for Sunstone's
structured-`Property[]` model.

**Live preview**:
Obsidian-style hybrid editing — markdown source is the source of truth, but inactive lines
render styled while the cursor line shows raw markup. Implemented via CodeMirror 6 decorations;
see the [CodeMirror integration](/editor/codemirror.md). It is the **`editing`** view mode; a
Tile's view mode is a boolean (`editing` vs read-only `read`, default `read`), toggled by
**Edit** in the **Concept header** — see [ADR-0001](/adr/0001-codemirror-hybrid-live-preview.md).

**Diagram**:
The rendered output of a ` ```mermaid ` fenced code block. In source it is an ordinary fenced
code block (so it is excluded from the **Outline**, like all fenced code); under **Live preview**
it renders as a diagram on inactive lines and reveals its raw source when the cursor enters it.
_Avoid_: "chart", "graph" (use **Diagram**; reserve "graph" for the link/backlink sense).

### Deployment shapes

These three name how a **Sunstone Web** deployment relates to git. The shape is derived from the
**presence** of `SUNSTONE_GIT_*` configuration, never from a flag — see
[ADR-0007](/adr/0007-server-owns-the-git-sync-loop.md) and, for the normative variable/volume
table, `docker/README.md`.
_Avoid_: "mode on/off", "git mode", `SUNSTONE_GIT_MODE` — that variable was never shipped; name
the shape instead.

**plain**:
No `SUNSTONE_GIT_*` variable at all. The Bundle is whatever `SUNSTONE_BUNDLE` points at, and a
Save writes the file and **runs no git** — no commit, and no history (the read side short-circuits
too, so a Bundle bind-mounted inside some other repo can never serve *that* repo's log). The
shape of the read-only viewer.

**git-local**:
`SUNSTONE_GIT_BRANCH` set, no origin. The Bundle lives in a container-local clone and every Save
**commits** there, authored by the signed-in user — but nothing is pushed anywhere. The shape of
the Dex dev stack.

**git-synced**:
Branch plus `SUNSTONE_GIT_ORIGIN` plus a deploy key. The server clones origin on boot, commits
every Save, and runs the **Sync loop**. The shape of a collaborative wiki.

**Sync loop**:
The server-owned `fetch → rebase → push` cycle that runs only in the **git-synced** shape. A Save
kicks it immediately (so outbound latency is not the poll interval); external pushes are
discovered within `SUNSTONE_GIT_SYNC_INTERVAL_SECS`. It is offline-tolerant: an unreachable origin
leaves the wiki serving and editing, with commits queueing locally. See
[sunstone-server](/architecture/sunstone-server.md).
_Avoid_: "sidecar", "git-sync" (the sidecar recipes it replaced are deleted).

**Fork** (of a Concept):
The `foo-<ts>.md` file the Sync loop writes beside `foo.md` when a web edit and an origin edit
conflict: origin keeps the canonical name, the web bytes land in the fork verbatim. A fork is an
ordinary **Concept** — findable in the tree, **Search** and **Quick nav** — and inbound links keep
pointing at the canonical file. `<ts>` is the conflicting edit's author date,
`YYYYMMDDThhmmssZ`.
_Avoid_: "conflict copy", "conflict file".

### UI chrome

These name the layout, not the domain. Register is conventional editor chrome (VSCode-style),
deliberately not domain language — section headers are discoverability affordances.

**Pane**:
Any top-level layout region of the app shell. See [App shell](/interface/app-shell.md) for
the three-Pane layout.

**Sidebar**:
A Pane docked to the left or right edge, holding a vertical stack of **Sections**. Both a left
and a right Sidebar exist. The left holds **Explorer** and **Tags**; the right holds **Outline**
and **Backlinks** and starts collapsed. A Sidebar is collapsed/expanded by clicking its inner
border and resized by dragging it (the **Sidebar edge**); its width is remembered as View state.
See [Sidebars and Sections](/interface/sidebars.md).
_Avoid_: "side panel" (use Sidebar).

**Activity Rail**:
The thin, always-visible icon strip on the far-left edge of the app shell, outside the left
**Sidebar** (so it stays visible when the Sidebar is collapsed). Holds application-global
controls — a menu, **Quick nav**, **Search**, and a bottom user/avatar slot (login/logout, web
only) — none of which are scoped to the open Concept. See
[Activity Rail and Concept header](/interface/activity-rail.md).
_Avoid_: "toolbar", "nav bar" (there is no global nav/tool bar; the Rail and the per-Tile
**Concept header** replaced it).

**Concept header**:
The per-**Tile** control bar above each open Concept, carrying the controls scoped to that
Concept/Tile: back/forward, the **Edit** toggle, the **Properties** toggle, undo/redo (shown
only while editing), review, export-PDF, split, and close. A single open Concept therefore
shows just its Concept header — there is no second global bar above it. See
[Activity Rail and Concept header](/interface/activity-rail.md).
_Avoid_: "nav bar", "toolbar" (removed), "title bar".

**Section**:
One collapsible item in a Sidebar — an always-visible header plus a toggleable body. The current
Sections are **Explorer** (the Bundle tree), **Tags** (tags across the Bundle), **Outline** (the
open Concept's headings) and **Backlinks** (Concepts linking to the open Concept). The **Tags**
Section is hidden entirely when the Bundle carries no tags. See
[Sidebars and Sections](/interface/sidebars.md).
_Avoid_: "panel" (collides with VSCode's bottom dock).

**Outline**:
The **Section** listing the open Concept's markdown headings in document order, indented by
heading level. Selecting a heading scrolls the Editor pane to it. Derived live from the open
Concept's body (frontmatter and fenced code blocks excluded).

**Editor pane**:
The central Pane — a grid of **Tiles** arranged in **Columns**. See
[Editor layout](/editor/editor-layout.md).

**Column**:
A vertical stack of **Tiles** inside the Editor pane; the Editor pane is a row of
Columns. See [Editor layout](/editor/editor-layout.md).
_Avoid_: "split" for the noun (a Column is the unit; "Split Right/Down" name the
actions that create one).

**Tile**:
One editor cell within the Editor pane, showing a single open **Concept** with its
own view-mode, scroll and history. Exactly one is the **active Tile**. See
[Editor layout](/editor/editor-layout.md).
_Avoid_: "tab" (Tiles are always visible, never behind a tab bar), "split" (a
Tile is the cell; Split is the action), "editor group" (VSCode's tabbed term),
"pane" (a Tile is a cell inside the Editor pane, not a Pane itself).

**Accordion**:
The height-sharing behaviour of a Sidebar's stacked Sections (they share the viewport, each
body capped). Names the behaviour, not a single item — one item is a **Section**.

**Region**:
An interactive surface that can hold keyboard focus and defines its own keyboard semantics.
Orthogonal to Pane/Section; the six Regions form a fixed 3×2 grid and exactly one is active
at a time. See [Focus model](/interface/focus-model.md).
_Avoid_: "pane focus", "panel focus" (use "the active Region").

**Focused item**:
The single navigable item that currently holds focus *within* a Region (the roving-tabindex
element) — arrow keys move it, Enter activates it. In the **Explorer** it is **distinct from
the open Concept**. See [Focus model](/interface/focus-model.md).
_Avoid_: "cursor" (reserved for the CodeMirror text caret), "selection" (ambiguous).

**Search**:
Bundle-wide full-text search — the centered modal (`Ctrl+Shift+F`) that scans every Concept
body across the Bundle and lists matching path/line/snippet hits. Always means the cross-Bundle
operation.
_Avoid_: using "search" for the in-editor operation (use **Find**).

**Find** (Find & Replace):
The in-Concept, editor-local find/replace panel (`Ctrl+F`) docked above the Editor pane. Scoped
to the open Concept's body only (frontmatter lives outside the document — see ADR 0003 — and is
edited via the Properties Section, not Find). Always means the single-Concept operation.
_Avoid_: calling this "search" (reserved for the cross-Bundle **Search**).

**Quick nav**:
The fuzzy command palette (`Ctrl`/`Cmd`+`K`, or the **Activity Rail** icon) for jumping to a
Concept by path or tag. Opened from the Rail; navigates the active **Tile** to the chosen
Concept. Distinct from **Search** (full-text over bodies) — Quick nav matches names/paths/tags.
_Avoid_: "command palette" in prose (use **Quick nav**), "go to file".

## Relationships

- A **Bundle** contains many **Concepts** and **Reserved files**, nested in directories.
- A **Concept** has one **Frontmatter** block and one markdown body.
- A **Concept** links to other **Concepts** primarily via standard markdown links: bundle-absolute
  (`[x](/path.md)`) or relative (`[x](./path.md)`), and optionally via **Wikilinks** (`[[name]]`,
  resolved by filename). Links are tolerated even when broken. See [Linking](/okf/linking.md) for the
  complete link model — path vs name resolution, anchors/slugs, citations, backlinks and
  rename-rewrite.
- A **Sidebar** contains many **Sections**; each Section shows a view onto the Bundle or the
  open Concept. The **Accordion** is how a Sidebar's Sections share height.
- A **Region** is any focusable interactive surface; exactly one is the active Region at a time.
  Regions cut across Panes and Sections (see term). Each Region has at most one **Focused item**.
- In the **Explorer**, the **Focused item** (keyboard position) is independent of the open
  **Concept** (what the Editor shows); they coincide only until you arrow away.
- A Sunstone Web deployment is exactly one of the three **deployment shapes** — **plain**,
  **git-local**, **git-synced** — and only the last runs the **Sync loop**, which is the only
  thing that ever writes a **Fork**.

## Example dialogue

> **Dev:** "When I arrow down in the **Explorer**, does the **Editor** follow along?"
> **Domain expert:** "No — arrowing only moves the **Focused item**. The open **Concept**
> doesn't change until you press Enter on a tree row."
> **Dev:** "And if the same Concept is open in two **Tiles**?"
> **Domain expert:** "They share one buffer — edit in one Tile and the other reflects it.
> But only one is the active **Tile**, and that's the one the **Outline** and **Backlinks**
> describe."

## Flagged ambiguities

- "docs folder" / "vault" / "workspace" all referred to the opened root — resolved to **Bundle**.
- A git-backed deployment was briefly described as "**mode** on / off", after a proposed
  `SUNSTONE_GIT_MODE=off|on` variable. That variable **never shipped** — git is gated on the
  presence of any `SUNSTONE_GIT_*` configuration instead. Resolved to the three **deployment
  shapes** (**plain** / **git-local** / **git-synced**), which name the deployment rather than an
  env value and so survive the variable's deletion. _Avoid_: "mode on/off", "git mode",
  `SUNSTONE_GIT_MODE`. See [ADR-0007](/adr/0007-server-owns-the-git-sync-loop.md).
- "side panel" / "panel" / "pane" / "accordion section" were used loosely for the collapsible
  sidebar items — resolved to **Section**, inside a **Sidebar**, with **Accordion** naming only
  the height-sharing behaviour. "Panel" is avoided (VSCode bottom-dock collision).
- "search" referred to both the cross-Bundle full-text modal and the in-editor operation —
  resolved to **Search** (cross-Bundle only) vs **Find** (single-Concept only).
- "pane" was used loosely for "the thing keyboard focus moves between" — but focus targets
  (Editor, Explorer, Properties, ...) don't map to Panes (Properties is neither Pane nor
  Section). Resolved: the focus unit is a **Region**, orthogonal to Pane/Section.
- The code's workspace layer once named each editor cell a **`Pane`**, colliding with the
  domain **Pane** (a top-level app-shell region). Resolved: the cell is now the **`Tile`**
  class (state) + **`TileSlot`** (geometry); `Pane` is reserved for the domain region. See
  [Editor layout](/editor/editor-layout.md#how-the-code-models-a-tile).
- The code names per-user UI state (`BundleState`, `saveBundleState`, `loadBundleState`,
  `/api/bundle-state`) after the **Bundle**, but it is **not** part of the Bundle: it is
  last-open Concept, expanded folders, sidebar flags, and window geometry — held per user
  and never committed. The misnomer is sharper now that the **Bundle** is the git-committed
  content the web write path commits. Resolved term: **View state** — per-user, client-held
  (desktop: OS config dir; web: the browser, e.g. `localStorage`), never written into the
  Bundle. See [View state](/interface/view-state.md). _Avoid_: "Bundle state". (Code not yet
  renamed — flagged for a later rename slice.)
