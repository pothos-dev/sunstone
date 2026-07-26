import type {
  TreeNode,
  FileChange,
  TagCount,
  BundleState,
  SearchHit,
  RewriteSummary,
  AnchorRename,
  FileHistory,
  FileAtRev,
  RenderPayload,
  KnownBundle,
  SyncNotice,
} from '$lib/types';

/**
 * The Backend interface is the ONLY boundary between the frontend and Rust.
 * The frontend never imports `@tauri-apps/api` outside `src/lib/ipc/`.
 *
 * Two implementations satisfy it:
 *  - `tauri.ts`  — real, via `invoke(...)` / `listen(...)`
 *  - `fake.ts`   — in-memory over a seeded fixture Bundle (for Chromium/Playwright)
 *
 * When a slice adds a Rust command, add a method here and implement it in BOTH
 * impls. Paths crossing the seam are always bundle-relative, forward-slash.
 *
 * See ARCHITECTURE.md "The IPC seam".
 */
export interface Backend {
  /** Absolute path of the Bundle root opened via the CLI. */
  bundleRoot(): Promise<string>;

  // --- Launcher: known folders + runtime Bundle switch (slice: launcher) -----
  // When Sunstone starts with NO path (`sunstone` alone), no Bundle is open and
  // the frontend shows the launcher: a most-recent-first list of previously-
  // opened folders (each removable), plus an "Open folder…" native picker.
  // Picking a folder opens it IN-PROCESS via `openBundle`, after which the
  // frontend reloads so the whole app re-initializes against the new Bundle.

  /**
   * The currently-open Bundle root, or `null` when Sunstone launched with no
   * path and is showing the launcher. The frontend decides launcher-vs-editor
   * from this on startup.
   */
  currentBundle(): Promise<string | null>;

  /**
   * The launcher's known-folder list — previously-opened Bundles derived from
   * the persisted per-Bundle config — ordered most-recently-opened first.
   */
  listKnownBundles(): Promise<KnownBundle[]>;

  /**
   * Forget a known folder: drop its persisted per-Bundle config entirely (so the
   * store does not grow forever). `path` is a `KnownBundle.path`. Idempotent.
   */
  forgetBundle(path: string): Promise<void>;

  /**
   * Open `path` as the current Bundle in-process (build index, start watcher,
   * record it, restore its window geometry). Rejects if the folder is missing.
   * The caller reloads the webview afterwards so the app re-initializes.
   */
  openBundle(path: string): Promise<void>;

  /**
   * Native "open folder" chooser for the launcher's "Open folder…" button.
   * Resolves to the chosen absolute path, or `null` if the user cancelled.
   */
  pickFolder(): Promise<string | null>;

  /** Recursive directory tree of the Bundle (root node has path ''). */
  listTree(): Promise<TreeNode>;

  /** Raw markdown of a single Concept, by bundle-relative path. */
  readConcept(path: string): Promise<string>;

  /**
   * Write a Concept's raw markdown back to disk (autosave), by bundle-relative
   * path. The backend records the write so the filesystem watcher suppresses
   * its own echo (no reload loop / cursor jump).
   */
  writeConcept(path: string, content: string): Promise<void>;

  /**
   * Subscribe to filesystem changes in the Bundle (created/modified/removed),
   * as detected by the Rust watcher. Sunstone's own autosave writes are
   * suppressed and never delivered here. Returns an unsubscribe function.
   */
  onFileChanged(cb: (change: FileChange) => void): () => void;

  /**
   * Subscribe to divergence notices from the server's git sync loop (git-sync
   * spec §10.2-10.3): a conflicting web version forked beside the canonical
   * file, or a web deletion dropped because origin modified the file. Returns an
   * unsubscribe function.
   *
   * Only the git-synced `sunstone-server` deployment ever emits these: `http.ts`
   * listens for the named `sync` event on the SAME `/api/events` connection
   * `onFileChanged` uses, and `tauri.ts` is a deliberate NO-OP (the desktop runs
   * no sync loop, so no notice can ever arrive). Inbound content changes are NOT
   * reported here — they ride the ordinary `onFileChanged` watcher path.
   */
  onSyncNotice(cb: (notice: SyncNotice) => void): () => void;

  // --- Tree CRUD (slice: tree-crud) ---
  // Structural filesystem operations driven from the document tree. All paths
  // are bundle-relative, forward-slash; the backend validates them against the
  // Bundle root and rejects escapes / invalid targets. These are NOT recorded
  // as self-writes: structural changes SHOULD refresh the tree + index via the
  // watcher's `file-changed` event.
  //
  // Rename/move ALSO automatically rewrites links so they stay valid (slice:
  // link-auto-rewrite): inbound links from other Concepts AND the moved
  // Concept's own relative outbound links (folder moves apply this to every
  // contained Concept). They resolve to a `RewriteSummary` so the UI can report
  // how many links/files changed.

  /**
   * Create a new, empty Concept (`.md`) at `path`. The minimal stub is an empty
   * file — the rich frontmatter scaffold is a later slice. Rejects a non-`.md`
   * path, an existing target, or a path whose parent folder is missing.
   */
  createConcept(path: string): Promise<void>;

  /** Create a new folder (and any missing parents) at `path`. */
  createFolder(path: string): Promise<void>;

  /**
   * Rename or move `from` to `to` (both bundle-relative). Works for both
   * Concepts and folders; rejects an existing target or a missing target
   * folder. Links affected by the move are automatically rewritten to stay
   * valid; resolves to a summary of how many links across how many files
   * changed.
   */
  renamePath(from: string, to: string): Promise<RewriteSummary>;

  /**
   * Move `from` into the folder `toDir` (bundle-relative; '' for the Bundle
   * root), keeping the original name. Convenience over `renamePath`; auto
   * rewrites affected links and resolves to the same summary shape.
   */
  movePath(from: string, toDir: string): Promise<RewriteSummary>;

  /**
   * Delete `path` (a Concept or a folder, recursively). The frontend confirms
   * before calling this to avoid accidental data loss.
   */
  deletePath(path: string): Promise<void>;

  /**
   * Rewrite inbound link anchors after a heading in `target` was renamed in the
   * editor (slice: slug-anchor-rewrite). `renames` maps each changed heading's
   * old GitHub slug to its new slug; every Concept linking to `target` has its
   * matching `[[target#old]]` / `[text](/target.md#old)` anchors rewritten.
   * `target`'s OWN same-file anchors are handled in the open buffer, so they are
   * excluded here. Resolves to a summary of how many anchors across how many
   * files changed (drives the same rewrite toast as rename/move).
   */
  rewriteAnchors(target: string, renames: AnchorRename[]): Promise<RewriteSummary>;

  // --- Bundle index queries (slice: bundle-index-broken-links) ---
  // The Rust index is built on startup and kept current by the watcher. These
  // are the consumers' read surface over it. Paths are bundle-relative.

  /**
   * Every Concept path in the Bundle index. The broken-link decoration seeds a
   * SYNCHRONOUS existence cache from this (CodeMirror decorations are
   * synchronous, so they cannot await a per-link `conceptExists`). The cache is
   * refreshed on `onFileChanged` and on Concept switch. We expose the full list
   * (over per-path `conceptExists`) precisely because a one-shot snapshot makes
   * the synchronous decoration efficient.
   */
  listConceptPaths(): Promise<string[]>;

  /** Whether a Concept exists at `path` (companion to `listConceptPaths`). */
  conceptExists(path: string): Promise<boolean>;

  /** Sources linking TO `path` (backlinks). Used by the backlinks panel (slice 7). */
  backlinks(path: string): Promise<string[]>;

  /** All tags across the Bundle with per-tag counts. Used by the tags view (slice 8). */
  allTags(): Promise<TagCount[]>;

  /**
   * Concept paths carrying `tag` in their frontmatter `tags`. Used by the tag
   * browser (slice 8) to reveal the Concepts under a selected tag. The query
   * lives in the index (which already holds per-Concept tags) rather than
   * scanning on the frontend.
   */
  conceptsByTag(tag: string): Promise<string[]>;

  /** All distinct frontmatter `type` values. Used by new-concept autocomplete (slice 12). */
  allTypes(): Promise<string[]>;

  /**
   * All distinct top-level frontmatter keys used across the Bundle, sorted.
   * Feeds the Properties panel's key-name autocomplete (key-and-tag
   * autocomplete slice). The OKF recommended keys are merged in client-side, so
   * this is bundle-sourced only (distinct keys from every Concept's frontmatter).
   */
  allKeys(): Promise<string[]>;

  // --- Per-Bundle session state (slice: config-theme-state-store) ---
  // A reusable read/write seam for persisting per-Bundle UI state in the OS
  // config folder, keyed (in the backend) by the Bundle's absolute path. NEVER
  // written into the Bundle (docs/GLOSSARY.md). Slices add fields to `BundleState`
  // and round-trip them through this same pair (slice 13: `recentFiles`).

  /**
   * Load this Bundle's persisted session state (last-open Concept, expanded
   * folders, recent files, sidebar flags, window geometry). Robust to a
   * missing/corrupt store: resolves to a fresh-Bundle default (core fields
   * empty — `lastOpenConcept: null`, `expandedFolders: []` — and the optional
   * fields defaulted on read by the session store), never rejects.
   */
  loadBundleState(): Promise<BundleState>;

  /**
   * Persist this Bundle's session state. The frontend calls this (debounced)
   * when the open Concept or expanded folders change. Window geometry is owned
   * by Rust and merged separately, so passing the value loaded earlier carries
   * it through untouched.
   */
  saveBundleState(state: BundleState): Promise<void>;

  // --- Full-text search (slice: full-text-search) ---

  /**
   * Full-text (body content) search across the Bundle, on demand. Scans every
   * `.md` Concept body and returns matches (path + 1-based line + matching line
   * snippet), ordered by path then line. The query is a case-insensitive
   * literal "find text"; an empty/whitespace query yields no matches. The
   * backend caps the result count (a few hundred) so a very common term cannot
   * flood the channel or the UI; the frontend shows the capped list as-is.
   */
  search(query: string): Promise<SearchHit[]>;

  // --- Git seam: file history + file-at-revision (slice: backend-git-seam) ---
  // Just enough git for the review-diff feature; the backend does NO diffing
  // (the frontend diffs the working-tree read against a revision). Both go
  // through the system `git` binary. Paths are bundle-relative, forward-slash.

  /**
   * Ordered commit history (newest first) of the commits touching the
   * bundle-relative `path`, backed by `git log --follow`. Resolves to a
   * discriminated `FileHistory`: `{ status: 'ok', commits }` when git has
   * history, or a distinguishable unavailable status (`notARepo` / `untracked`
   * / `noHistory` / `gitMissing`) so the review-diff toggle can disable itself
   * WITHOUT a thrown error. Only a path-escape rejects.
   */
  fileHistory(path: string): Promise<FileHistory>;

  /**
   * Full text of the bundle-relative `path` at revision `rev`, backed by
   * `git show <rev>:<path>`. The working-tree side is the ordinary
   * `readConcept`; the frontend diffs the two. Resolves to a discriminated
   * `FileAtRev`: `{ status: 'ok', content }`, or a distinguishable failure
   * (`notARepo` / `notFound` / `gitMissing`). Only a path-escape rejects.
   */
  fileAtRev(path: string, rev: string): Promise<FileAtRev>;

  // --- Server-quality render (slice: desktop-render-seam) ---

  /**
   * Render the Concept at `path` (bundle-relative) to a `RenderPayload`: the
   * body rendered to read-only HTML (CriticMarkup annotations track-changed to
   * their `critic-*` classes, wikilinks/markdown links resolved against the
   * Bundle index), plus the parsed frontmatter and heading outline. This is the
   * SAME server-quality render the web viewer consumes; on the desktop it feeds
   * the "Export as PDF" print path (the reading view itself stays CodeMirror).
   * Rendering lives in Rust core; the fake backend approximates it enough to be
   * behaviourally useful under Playwright.
   */
  renderConcept(path: string): Promise<RenderPayload>;

  // --- Print / PDF preview (slice: print-preview-window) ---

  /**
   * Open a chrome-free print/PDF preview of the Concept at `path`
   * (bundle-relative) in its OWN window/tab, so it can be inspected before
   * saving. The preview renders the same server-quality HTML as `renderConcept`
   * and offers reader controls (font size, margins) plus Print / Save-as-PDF.
   *
   * On the desktop this opens a SEPARATE native window (WebKitGTK has no rich
   * PDF chrome of its own); the fake/HTTP impls open a new browser tab. The web
   * viewer opens a bare tab directly (no toolbar) and relies on the browser's
   * native print → Save-as-PDF UI, so it does not use this seam.
   */
  openPrintWindow(path: string): Promise<void>;

  /**
   * Export the print window's current rendering straight to a PDF FILE, skipping
   * the OS print dialog. Prompts for a destination with a native save-file
   * chooser (default file name `defaultName`) and writes the PDF, resolving to
   * the saved absolute path — or `null` if the chooser was cancelled. Rejects on
   * platforms without direct export so the caller can fall back to
   * `window.print()`. Desktop-only; the fake/HTTP impls resolve to `null`.
   */
  savePdf(defaultName: string): Promise<string | null>;

  // --- External links (slice: open-external-links) ---

  /**
   * Open an external (scheme) URL — `http(s)://`, `mailto:`, `tel:` — in the
   * user's default application (browser/mail client), NOT in-app. The desktop
   * WebKitGTK webview swallows `window.open`, so the real impl routes through
   * the Tauri opener plugin; the fake/HTTP impls (running in a real browser)
   * open a new tab. `resolveLink` classifies which hrefs are external.
   */
  openExternal(url: string): Promise<void>;
}
