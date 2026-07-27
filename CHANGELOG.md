# Changelog

All notable changes to Sunstone are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.19.3] - 2026-07-27

### Changed

- The published Sunstone Web image now lives on GHCR
  (`ghcr.io/pothos-dev/sunstone-web`) instead of Docker Hub. Compose files and
  the deployment docs default to the new location.

## [0.19.2] - 2026-07-27

### Fixed

- Mermaid diagrams no longer crash on their first render in the production build.
- Restoring the previously open Concept on startup no longer briefly shows its raw
  frontmatter block, even with Properties hidden — switching Concepts always looked
  right, but the very first restored one didn't.
- Horizontal padding is back on Concept header icons.

## [0.19.1] - 2026-07-27

### Fixed

- On Sunstone Web, the address bar now follows the Concept you have open when
  signed in — navigating and the browser's Back/Forward land on the right
  Concept, and a reload no longer flashes the read-only surface in the wrong
  theme before showing the wrong Concept. Splitting the editor into multiple
  panes is no longer available on the web, which is what keeps the URL
  well-defined.
- The review-changes diff no longer shows an empty "no changes" step when an
  unrelated commit sits between two revisions of a file.
- A stray 6px gap next to the sidebar seams is gone.

## [0.19.0] - 2026-07-27

### Added

- **Git-synced wiki** — a web deployment can now be backed by a git remote
  instead of a plain folder. The server clones the repository on boot, commits
  every Save as the signed-in user, and continuously reconciles with the remote,
  so edits made in the browser and changes pushed from a clone converge on their
  own. Nothing sits beside it: no sidecar, no host-side hook, no manual step.
- **A conflict never blocks a Save.** When a browser edit and an incoming change
  touch the same Concept, the remote keeps the canonical name and your version is
  written beside it as an ordinary Concept — `notes/foo-20260727T101500Z.md`,
  which appears in the tree, in Search and in Quick nav — with a dismissible
  notice in the editor. The history behind it still holds every author's edit.
- **Live updates from outside the browser** — a change pushed to the remote
  reaches every connected reader within one sync interval, the same way a local
  file change already did.

### Changed

- In a web deployment, **file history and the review-changes diff now require
  signing in.** Between them they expose every revision of every file, including
  content deleted from the Bundle, so they are gated with the write path rather
  than left open to anonymous readers.
- The container **refuses to boot on an unrecognised `SUNSTONE_GIT_*` variable**,
  reporting every configuration error at once. A typo, or a leftover variable from
  an older sync mechanism, is now a startup failure instead of a wiki that quietly
  serves un-synced content.

### Fixed

- The git deploy key is no longer readable from the web server process's
  environment. Only the component that runs `git` receives it.

## [0.18.0] - 2026-07-25

### Added

- **Sunstone on the web** — Sunstone now runs as a hosted web app: sign in to
  open your Bundle in the browser and edit it with the full editor, saving your
  changes explicitly.

### Changed

- **Redesigned interface** — a new Activity Rail holds global controls (Quick
  nav, Search, theme), per-Concept controls move into a per-Tile header, editing
  is a single Edit toggle, and the sidebars are resizable and collapsible.

## [0.17.0] - 2026-07-22

### Changed

- **New Sunstone look** — a warm amber palette and the Jost typeface throughout
  the app.
- The per-Tile Close control moved to the right edge and only appears when more
  than one Tile is open.
- Every folder now starts collapsed when a fresh Bundle is opened.

### Added

- Absolute in-Bundle links now resolve against the nearest enclosing OKF bundle
  root, so nested bundles link correctly.

## [0.16.0] - 2026-07-22

### Added

- **Multi-Concept tiling workspace** — split the editor into columns and tiles to
  view several Concepts side by side, with draggable dividers, per-tile close, and
  `Alt`+arrow navigation across the grid. A slim per-Pane header carries per-pane
  controls, and the tiled layout persists across restarts.
- **Export as PDF** — render the open Concept to an inspectable print-preview
  window (server-quality HTML with reader controls) and print or save it; on macOS
  and Windows a direct Save-as-PDF skips the OS print dialog.
- **Review changes** — a working-tree ↔ HEAD review toggle backed by a git seam,
  with a file-history stepper that walks consecutive revisions; scattered word
  edits render as CriticMarkup track-changes.
- **Inline citations** render as clickable superscript links, keeping the `[n]`
  brackets.
- **External links** (`http(s)`/`mailto`/`tel`) now open in the OS default
  browser instead of being swallowed by the desktop webview.
- Global Properties (frontmatter) toggle, applied per-tile.
- The launcher opens a chosen known folder when Sunstone is started with no path.
- Tag path disambiguation plus quick-nav tag search and drill-down.

### Changed

- The Source/Live/Read view-mode control is now a global NavBar control with icons
  instead of floating over the Concept view.
- In Reading mode a click anywhere on a link's text follows the link, not just the
  trailing open-in-new icon.
- Folders containing an `index.md` collapse by default on first open.

### Fixed

- The print preview follows in-Bundle links, and the `?print` overlay is detected
  in the catch-all route so the desktop preview opens correctly.
- Desktop install builds from the workspace-root target directory.

## [0.15.2] - 2026-07-16

### Fixed

- Sunstone Web: the browser tab title now shows the open Concept's name — a
  stray static `<title>` in the page template was overriding it.

## [0.15.1] - 2026-07-16

### Changed

- Sunstone Web now addresses a Concept by its path in the URL
  (`/research/providers/mistral-ai`) instead of a `?path=` query, dropping the
  `.md` extension and a trailing `/index` (the Bundle root is `/`). In-Bundle
  links use these paths too.
- The browser tab title is now the open Concept's name — its frontmatter
  `title`, else its first heading, else its file name.

## [0.15.0] - 2026-07-16

### Added

- **Sunstone Web** — a server-rendered, read-only web viewer for a Bundle,
  shipped as a Docker image. A Rust HTTP server (`sunstone-server`) runs over the
  same core as the desktop app behind a SvelteKit SSR frontend, so a Bundle can be
  browsed in any browser:
  - Server-side Concept rendering with resolved markdown + wikilinks, broken-link
    styling, frontmatter, and outline.
  - Explorer tree, Backlinks, Tags, and Outline sidebars plus bundle-wide
    full-text Search — matching the desktop chrome (dark/light theme, collapsible
    sections, persisted UI state).
  - Live reload: external edits to the Bundle stream to every connected viewer
    over SSE.
  - Mermaid diagrams rendered client-side.
  - Multi-arch image published to Docker Hub on release; deploy docs cover
    folder-mount and git-backed sidecar sync (read-only, internal-network only).
- Editor remembers the source/live/read view mode across restarts.

### Fixed

- Toggling to read mode no longer leaves an editing affordance on Mermaid diagrams.

## [0.14.0] - 2026-07-13

### Added

- CriticMarkup annotations: highlight passages and attach comments directly in
  the editor. Comments show a gutter icon and open a note popup for editing.
- Right-click context menu in the editor with formatting actions (bold, italic,
  etc.), Cut/Copy/Paste, and Add/Remove comment.
- Reading view now caps line length with a centered max-width measure for more
  comfortable reading.

### Changed

- Sidebar Sections are now justified to the top and bottom edges.

### Fixed

- Annotations no longer reveal their raw CriticMarkup on click in reading mode.
- Comment notes containing a line break no longer break rendering or saving.
- URL-less brackets like `[1]` are no longer rendered as links.
- The context menu no longer shows a leading divider when a link is the first
  item.

## [0.13.0] - 2026-07-01

### Added

- Heading anchors now resolve GitHub-style by slug: `[[Page#deep-section]]` (and
  `[text](/page.md#deep-section)`) jumps to a `## Deep Section` heading. Older
  literal anchors (`#Deep Section`) keep working — both sides are slugged.
- Renaming a heading in the editor automatically rewrites the anchors that point
  at it — inbound links in other documents and same-file `[[#…]]` links — to the
  heading's new slug, with a brief summary toast. Deleting a heading leaves its
  inbound anchors alone (they break rather than silently repoint).

## [0.12.3] - 2026-07-01

### Changed

- Wide markdown tables now wrap long cell content instead of forcing the table
  to scroll horizontally.

### Fixed

- A renamed or moved folder now stays expanded, and recent-file entries follow
  the move, instead of the folder collapsing and recents pointing at stale paths.
- A stale "could not open" error banner now clears when the missing file is
  created/fixed by another tool and the editor reloads it.
- Frontmatter parsing no longer leaks the closing `---` fence into the document
  body when the frontmatter block is empty.

## [0.12.2] - 2026-06-29

### Added

- Mouse back/forward (thumb) buttons now navigate concept history, mirroring
  Ctrl/Cmd+Alt+Left/Right.

### Changed

- The Properties panel's minimized/expanded state is now a single sticky
  preference that persists across concept switches and restarts (previously it
  reset per concept and always reopened expanded).
- Editor prose base font size and the Explorer file-tree font size both set to 14px.

## [0.12.1] - 2026-06-25

### Fixed

- Moving a folder or file no longer leaves stale entries in the reference map,
  which previously could break renaming the outer folder afterwards.

## [0.12.0] - 2026-06-25

### Added

- Markdown formatting keyboard shortcuts (Obsidian-style, all toggling):
  Ctrl/Cmd+B (bold), +I (italic), +E (inline code), +Shift+M (strikethrough),
  +1–6 (headings H1–H6) and +0 (paragraph).
- Explorer: Space toggles folders and opens concepts, alongside Enter.

### Fixed

- Inline code in table cells now renders in monospace.

## [0.11.0] - 2026-06-23

### Added

- Mermaid diagrams: ` ```mermaid ` fenced blocks render as diagrams in Live and
  Read modes, themed to match the app's light/dark palette and font. Double-click
  (or the Source toggle) to edit; invalid diagrams show an inline error with the
  source.
- CLI `--detached` / `-d` flag to launch the app detached from the spawning
  console, returning the shell prompt immediately.

### Changed

- CLI argument handling: `--version` and `--help` now print to the console and
  exit without opening a window, and unknown options or extra arguments are
  rejected with an error.

### Fixed

- Bundle identifier no longer ends in `.app` (renamed to `md.sunstone.editor`),
  resolving the macOS application-bundle extension collision warning.

## [0.10.0] - 2026-06-23

### Added

- Wikilinks: `[[name]]` parsing with bundle-wide name resolution, rendering and
  navigation in live preview, backlinks, and automatic link rewriting on rename.
- Tri-state editor view mode toggle: Source / Live / Read.
- Collapsible frontmatter Properties panel, auto-revealed when it gains focus.
- Support for non-OKF folders: empty frontmatter collapses and the missing-`type`
  nag is dropped, so any plain markdown folder opens cleanly.
- Tidier Explorer folder rows: aligned caret, click-to-open index, child indent.

### Changed

- The rename input hides the implicit `.md` extension and re-appends it on confirm.

### Fixed

- Numeric frontmatter values (e.g. `order: 3`) are no longer silently quoted into
  strings on save, preserving their YAML type across the round-trip.

## [0.9.0] - 2026-06-18

First public release. Sunstone is a Tauri-based markdown knowledge editor.

### Added

- Explorer tree with full keyboard navigation and CRUD keybindings on the focused item.
- Region focus model: an active Region plus Alt-directional movement between Regions, with a unified Escape "peel" model and overlay restore-to-opener.
- Keyboard navigation for the Outline and Backlinks Regions.
- Properties metadata editor as a spreadsheet-style grid with keyboard navigation, chip-cell sub-navigation, and reachable add-controls.
- Tags browser with multi-expand and tree keyboard navigation.
- Drag-and-drop moving of Concepts and folders in the explorer tree.
- In-Concept Find & Replace, scrolling the highlighted result into view on arrow-key navigation.
- Transient auto-reveal of Regions hidden by a collapsed Section.
- Full-text search backend (ripgrep libraries, no external binary).
- Filesystem change watching with autosave.
- Unit test suite for pure library utilities plus a Playwright end-to-end suite.

### Fixed

- Bare and autolinked URLs no longer vanish in live preview.
- Focused-item highlight rings are gated on focus and start in the Explorer.
- Section-collapsed Regions are revealed correctly on Alt-in.
- The active-Region lift now shows on the Properties (metadata) editor.
