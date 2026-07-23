// Shared TypeScript types crossing the IPC seam.
// Shapes must match the Rust serde structs (serde rename_all = "camelCase").
// See ARCHITECTURE.md and docs/GLOSSARY.md.

import type { EditorMode } from '$lib/editor/cm';
import type { StoredLayout } from '$lib/state/layoutPersist';

/**
 * A node in the Bundle's directory tree. Paths are bundle-relative,
 * '/'-separated, and '' for the root node.
 */
export type TreeNode = {
  name: string;
  path: string; // bundle-relative, '/'-separated, '' for root
  isDir: boolean;
  children?: TreeNode[]; // dirs only
};

/**
 * A Concept: a single `.md` file in the Bundle. Carries YAML frontmatter
 * (required `type`) and a free-form markdown body. (docs/GLOSSARY.md)
 *
 * Slice 1 only needs the raw markdown over the seam; richer parsed forms
 * (parsed frontmatter, links) arrive with the index slices. We define the
 * shape now so later slices extend rather than reinvent it.
 */
export type Concept = {
  /** bundle-relative, '/'-separated path of the `.md` file */
  path: string;
  /** raw markdown content, including the frontmatter block */
  content: string;
};

/**
 * A filesystem change reported by the Rust watcher over the IPC seam.
 * `paths` are bundle-relative, '/'-separated. Sunstone's own autosave writes
 * are suppressed by the backend and never appear here.
 */
export type FileChange = {
  /** what happened to the paths */
  kind: 'created' | 'modified' | 'removed';
  /** affected bundle-relative paths */
  paths: string[];
  /**
   * Attribution for a *web write* (ticket 08): the originating tab's `clientId`
   * plus the authoring user. `null`/absent for a desktop or external edit —
   * always treated as a genuine external change. Each browser drops the echo of
   * its own write by matching `origin.clientId` against its per-tab client id.
   */
  origin?: FileChangeOrigin | null;
};

/** Web-write attribution stamped onto a broadcast {@link FileChange}. */
export type FileChangeOrigin = {
  /** the originating browser tab's in-memory client id */
  clientId: string;
  /** the authoring user (OIDC identity) — only the name is carried */
  author: { name: string };
};

/**
 * A tag and the number of Concepts that carry it. Matches the Rust `TagCount`
 * (`serde rename_all = "camelCase"`). Returned by `Backend.allTags()`.
 */
export type TagCount = {
  tag: string;
  count: number;
};

/**
 * One entry in the launcher's "known folders" list — a previously-opened Bundle,
 * derived from the persisted per-Bundle config. Matches the Rust `KnownBundle`
 * (`serde rename_all = "camelCase"`). Returned by `Backend.listKnownBundles()`,
 * ordered most-recently-opened first.
 */
export type KnownBundle = {
  /** absolute path of the Bundle root; also the store key used by forgetBundle/openBundle */
  path: string;
  /** display basename of the folder */
  name: string;
  /** Unix milliseconds the Bundle was last opened, or null if never stamped */
  lastOpened: number | null;
  /** whether the folder still exists on disk (a moved/deleted folder is flagged, not dropped) */
  exists: boolean;
};

/**
 * Per-Bundle session state persisted in the OS config folder (NEVER in the
 * Bundle). Matches the Rust `BundleState` (`serde rename_all = "camelCase"`).
 *
 * Designed to be EXTENDED (e.g. `recentFiles` and the sidebar flags below were
 * added this way). Both the Rust and fake backends tolerate missing/extra
 * fields, so adding a field here only requires defaulting it on read. `window`
 * is owned by Rust (it carries the window geometry through round-trips) and is
 * opaque to the frontend.
 */
export type BundleState = {
  /** bundle-relative path of the last-open Concept, or null if none */
  lastOpenConcept: string | null;
  /** bundle-relative paths of folders the user had expanded in the tree */
  expandedFolders: string[];
  /** window geometry, owned by Rust; opaque to the frontend (pass-through) */
  window?: unknown;
  /**
   * Bundle-relative paths of recently-opened Concepts, most-recent first.
   * Deduped and capped; used by the quick-nav palette's empty-input view.
   * Persisted per-Bundle in the OS config folder, never in the Bundle.
   */
  recentFiles?: string[];
  /**
   * Sidebar collapse state (persist-sidebar-collapse-state). All optional and
   * tolerated when missing; the session store defaults each to `true` on read,
   * so a fresh Bundle opens with the left Sidebar and every Section expanded.
   */
  /** whether the left Sidebar is expanded (vs collapsed entirely) */
  leftSidebarOpen?: boolean;
  /** whether the Explorer section is expanded */
  explorerOpen?: boolean;
  /** whether the Tags section is expanded */
  tagsOpen?: boolean;
  /** whether the Backlinks section is expanded */
  backlinksOpen?: boolean;
  /**
   * whether the right Sidebar (Backlinks; later Outline) is expanded
   * (right-sidebar-move-backlinks). Unlike the flags above this defaults to
   * `false` on read — the right Sidebar starts collapsed on a fresh Bundle.
   */
  rightSidebarOpen?: boolean;
  /**
   * whether the Outline section (in the right Sidebar) is expanded
   * (outline-section). Defaults to `true` on read, so the Outline shows the
   * moment the right Sidebar is first expanded.
   */
  outlineOpen?: boolean;
  /**
   * GLOBAL Properties show/hide flag (slice: multi-concept-tiling). When `true`,
   * every visible tile renders its Concept's frontmatter inline; when `false`
   * (the default on read) no tile shows any Properties chrome. Persisted so the
   * choice survives a relaunch. Replaces the old per-panel `propertiesOpen`
   * collapse flag.
   */
  propertiesShown?: boolean;
  /**
   * The editor's view mode — the boolean `editing`/`read` (editing-boolean-edit-
   * toggle), restored on relaunch (persist-editor-mode). Optional so older files
   * tolerate its absence; the session store migrates the legacy tri-state values
   * ('edit'/'hybrid'/'view') and defaults it to `read` on read.
   */
  editorMode?: EditorMode;
  /**
   * Persisted tiling workspace layout (multi-concept-tiling ticket 06): the row
   * of columns of tiles — each column's order + weight, each tile's order +
   * weight + Concept path + per-tile view-mode, and which tile is active.
   * Optional so older sessions (which have only `lastOpenConcept` + a single
   * `editorMode`) tolerate its absence and are migrated to a single tile on read;
   * `null`/corrupt falls back to one empty tile. The Rust backend round-trips it
   * as opaque JSON (see `config.rs`); the frontend owns the `StoredLayout` shape.
   */
  layout?: StoredLayout | null;
};

/**
 * One full-text search match: a Concept (by bundle-relative path), the 1-based
 * line number of the match, and the matching line's text (snippet). Matches the
 * Rust `SearchHit` (`serde rename_all = "camelCase"`). Returned by
 * `Backend.search()`.
 */
export type SearchHit = {
  /** bundle-relative, '/'-separated path of the matched Concept */
  path: string;
  /** 1-based line number of the match within the Concept body */
  line: number;
  /** the matching line's text */
  snippet: string;
};

/**
 * Summary of an automatic link-rewrite pass after a Concept/folder rename or
 * move: how many links across how many files were rewritten to stay valid.
 * Matches the Rust `RewriteSummary` (`serde rename_all = "camelCase"`).
 * Returned by `Backend.renamePath()` / `Backend.movePath()`.
 */
export type RewriteSummary = {
  /** total number of individual links rewritten */
  linksChanged: number;
  /** number of distinct Concept files whose content was changed */
  filesChanged: number;
};

/**
 * One heading-slug rename, sent to `Backend.rewriteAnchors()` when a heading's
 * GitHub-style slug changes in the editor. Inbound `[[target#from]]` /
 * `[text](/target.md#from)` anchors are rewritten to `#to`. Matches the Rust
 * `AnchorRename` (`serde rename_all = "camelCase"`).
 */
export type AnchorRename = {
  /** the heading's previous slug (what existing links still point at) */
  from: string;
  /** the heading's new slug */
  to: string;
};

/**
 * One commit that touched a file, as returned by `Backend.fileHistory()`.
 * Matches the Rust `FileCommit` (`serde rename_all = "camelCase"`).
 */
export type FileCommit = {
  /** abbreviated commit hash (`git %h`) */
  hash: string;
  /** commit subject — the first line of the message (`git %s`) */
  subject: string;
  /** author name (`git %an`) */
  author: string;
  /** author date, ISO-8601 strict (`git %ad --date=iso-strict`) */
  date: string;
  /** human relative author date, e.g. "3 days ago" (`git %ar`) */
  relativeDate: string;
};

/**
 * Result of `Backend.fileHistory()`: either the ordered commit list (newest
 * first) or a distinguishable reason the history is unavailable. A discriminated
 * union on `status` (matches the Rust `FileHistory`, `serde tag = "status"`) so
 * the review-diff UI can disable its toggle without a thrown error:
 *   - `notARepo`   — the Bundle is not inside a git repository
 *   - `untracked`  — the file is not tracked by git
 *   - `noHistory`  — the file is tracked but no commit touches it
 *   - `gitMissing` — the `git` binary is unavailable (also the web build, which
 *                    has no git seam)
 */
export type FileHistory =
  | { status: 'ok'; commits: FileCommit[] }
  | { status: 'notARepo' }
  | { status: 'untracked' }
  | { status: 'noHistory' }
  | { status: 'gitMissing' };

/**
 * Result of `Backend.fileAtRev()`: the file's full text at a revision, or a
 * distinguishable failure. Discriminated union on `status` (matches the Rust
 * `FileAtRev`, `serde tag = "status"`).
 */
export type FileAtRev =
  | { status: 'ok'; content: string }
  | { status: 'notARepo' }
  | { status: 'notFound' }
  | { status: 'gitMissing' };

/**
 * One frontmatter entry for the read-only Properties view of a rendered
 * Concept. A scalar has a single value; a sequence (e.g. `tags`) has several.
 * Matches the Rust `FrontmatterField` (`serde rename_all = "camelCase"`).
 */
export interface FrontmatterField {
  key: string;
  /** scalar → one value; sequence (e.g. `tags`) → several */
  values: string[];
}

/**
 * One outline heading (document order): level, text, de-duplicated GitHub slug.
 * Matches the Rust `OutlineHeading` (`serde rename_all = "camelCase"`).
 */
export interface OutlineHeading {
  level: number;
  text: string;
  slug: string;
}

/**
 * The server-quality rendered read-only view of a Concept: body HTML (with
 * CriticMarkup annotations and resolved wikilinks; frontmatter excluded), the
 * parsed frontmatter, and the heading outline. Produced in Rust core by
 * `render_concept` — consumed by the web viewer AND, over the seam, by the
 * desktop print/PDF path. Matches the Rust `RenderPayload`
 * (`serde rename_all = "camelCase"`). Returned by `Backend.renderConcept()`.
 */
export interface RenderPayload {
  /** rendered body HTML (frontmatter excluded; links resolved to viewer nav) */
  html: string;
  frontmatter: FrontmatterField[];
  outline: OutlineHeading[];
}

/**
 * Parsed YAML frontmatter on a Concept. Only `type` is required; other keys
 * are recommended and unknown keys must be preserved. Filled in by later
 * index slices; defined here so the vocabulary is stable.
 */
export type Frontmatter = {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  timestamp?: string;
  /** unknown keys are preserved verbatim */
  [key: string]: unknown;
};
