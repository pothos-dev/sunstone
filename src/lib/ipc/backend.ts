import type {
  TreeNode,
  FileChange,
  TagCount,
  BundleState,
  SearchHit,
  RewriteSummary,
  AnchorRename,
  OkfMarker,
  FileHistory,
  FileAtRev,
  RenderPayload,
  KnownBundle,
  StartupDocument,
  SyncNotice,
  UpdateNotice,
  ReleaseNotes,
} from '$lib/types';

/**
 * The Backend interface is the ONLY boundary between the frontend and Rust.
 * The frontend never imports `@tauri-apps/api` outside `src/lib/ipc/`.
 *
 * Three implementations satisfy it:
 *  - `tauri.ts`  — desktop, via `invoke(...)` / `listen(...)`
 *  - `http.ts`   — web, via `fetch` to `/_api/...` on sunstone-server
 *  - `fake.ts`   — in-memory over a seeded fixture Bundle (for Chromium/Playwright)
 *
 * When a slice adds a Rust command, add a method here and implement it in ALL
 * THREE impls. Paths crossing the seam are always bundle-relative, forward-slash.
 *
 * See docs/architecture/web-frontend.md "The IPC seam".
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
   * The Document named on the command line after the Bundle, handed out once:
   * later calls (e.g. after a webview reload) return `null`, as does a launch
   * that named none. The editor opens it after restoring the layout. Under
   * `sunstone serve` the page URL names it instead (`ipc/servedStartup.ts`); a
   * URL with no Concept behind it rejects, and the editor shows the message.
   */
  takeStartupDocument(): Promise<StartupDocument | null>;

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
   * The user's colour and font overrides — `{ colors?, fonts? }` from the
   * desktop `config.json` (or, on the web, the file `SUNSTONE_CONFIG` names), as
   * the raw JSON the user wrote; `appearanceCss` validates it. `null` when none
   * are set. Never rejects for a missing/corrupt config.
   */
  loadAppearance(): Promise<unknown>;

  /**
   * The URL a font file listed in the config (`fonts.<role>.files`, relative to
   * the config's directory) is served at. Synchronous, like `attachmentUrl`:
   * it only builds a string for an `@font-face` `src`.
   */
  fontUrl(src: string): string;

  /**
   * Open `path` as the current Bundle in-process (build index, start watcher,
   * record it, restore its window geometry). Rejects if the folder is missing.
   * The caller reloads the webview afterwards so the app re-initializes.
   */
  openBundle(path: string): Promise<void>;

  /**
   * Create a Bundle at the existing folder `path`, then open it as `openBundle`
   * does. Creating declares the folder OKF (ov-8): its root `index.md` gains
   * `okf_version` (written fresh when absent, the key added when missing, the
   * rest of the file kept) unless it already declares a version, which is left
   * alone. No other `index.md` is touched. The caller reloads afterwards.
   */
  createBundle(path: string): Promise<void>;

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
   * listens for the named `sync` event on the SAME `/_api/events` connection
   * `onFileChanged` uses, and `tauri.ts` is a deliberate NO-OP (the desktop runs
   * no sync loop, so no notice can ever arrive). Inbound content changes are NOT
   * reported here — they ride the ordinary `onFileChanged` watcher path.
   */
  onSyncNotice(cb: (notice: SyncNotice) => void): () => void;

  // --- Desktop updates (src-tauri/src/updater.rs, release_notes.rs) ---------

  /**
   * Subscribe to the desktop updater's notice for this run: a newer version was
   * installed, queued for exit, or (package-managed Linux installs) is available
   * to download. At most one per run; a notice raised before the subscription is
   * delivered on subscribe. Returns an unsubscribe function. The web build has no
   * updater, so `http.ts` never calls back.
   */
  onUpdateNotice(cb: (notice: UpdateNotice) => void): () => void;

  /**
   * The release notes to show after an update, handed out once: later calls
   * (e.g. after a webview reload) and a start without an update give `null`.
   * Always `null` on the web.
   */
  takeReleaseNotes(): Promise<ReleaseNotes | null>;

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
   * synchronous, so they cannot await a per-link existence query). The cache is
   * refreshed on `onFileChanged` and on Concept switch. The seam exposes the
   * full list — not a per-path existence method — precisely because a one-shot
   * snapshot makes the synchronous decoration efficient.
   */
  listConceptPaths(): Promise<string[]>;

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
   * Feeds frontmatter key-name autocomplete; awaiting the
   * marker-gated completion of ADR 0009 (key-and-tag
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
   * PDF chrome of its own); the fake/HTTP impls open a new browser tab (the
   * signed-in web shell goes through here). Only the anonymous web read surface
   * bypasses this seam: it opens a bare tab directly (no toolbar) and relies on
   * the browser's native print → Save-as-PDF UI.
   */
  openPrintWindow(path: string): Promise<void>;

  /**
   * Export the print window's current rendering straight to a PDF FILE, skipping
   * the OS print dialog. Prompts for a destination with a native save-file
   * chooser (default file name `defaultName`) and writes the PDF, resolving to
   * the saved absolute path — or `null` if the chooser was cancelled. Rejects on
   * platforms without direct export so the caller can fall back to
   * `window.print()`. Desktop-only; the fake/HTTP impls always reject.
   */
  savePdf(defaultName: string): Promise<string | null>;

  /**
   * Set the app window title (the desktop App keeps it on the active Concept).
   * Desktop sets the native window title; the fake/HTTP impls set
   * `document.title`.
   */
  setWindowTitle(title: string): Promise<void>;

  /**
   * Register `flush` to run before the app goes away, so debounced work (the
   * Document autosave, session persistence) is written instead of dropped.
   * Returns an unsubscribe.
   *
   * Desktop: on the main window's close request — the close WAITS for `flush`
   * (bounded by {@link CLOSE_FLUSH_TIMEOUT_MS}, so a hung write can never keep the
   * window open). HTTP (web): on `pagehide` (reload, navigation, tab close),
   * best-effort — the browser does not wait for an async handler, so only work
   * that starts synchronously is guaranteed to land. Fake: only on its
   * `simulateCloseRequest` test hook, which models the desktop close.
   */
  onBeforeClose(flush: () => Promise<void>): () => void;

  /**
   * Every `index.md` in the Bundle whose Frontmatter declares `okf_version`
   * (OKF v0.2 §12), at any depth, sorted by path. The Bundle-root finder
   * (`sunstone-shared/src/bundle_root.rs`) is pure, so the marker reaches it as
   * data: `indexStore` hands this list to the wasm `BundleIndex` beside
   * `listConceptPaths`, and the handle picks the root (outermost declaration
   * wins) and reports the declared version (`okfVersion()`).
   *
   * All three impls answer from the same shared parse (`okf_version_of`):
   * `tauri.ts` / `http.ts` from the Rust index (`Index::okf_markers`), `fake.ts`
   * over its in-memory store through wasm `okfVersionOf`.
   */
  listOkfMarkers(): Promise<OkfMarker[]>;

  /**
   * The opened folder's path within the git repository containing it (`''` =
   * it is the toplevel, `'docs'` = the repository root is one level up), or
   * `null` when it is in no repository. The input to the git-toplevel rung of
   * the Bundle-root ladder (`sunstone-shared/src/bundle_root.rs`): `indexStore`
   * hands it to the wasm `BundleIndex` beside the markers, keeping the finder
   * pure.
   *
   * `tauri.ts` / `http.ts` ask git once per opened Bundle
   * (`AppState::git_prefix`, `git rev-parse --show-prefix`); `fake.ts` models a
   * Bundle at its repository toplevel and answers `''`.
   */
  gitPrefix(): Promise<string | null>;

  // --- Attachments (slice: attachment-files) ---

  /**
   * Every **Attachment** path in the Bundle (bundle-relative, forward-slash,
   * sorted). An Attachment (docs/GLOSSARY.md) is a non-`.md` file stored in the
   * Bundle — today an image file — and it is what an Embed (`![alt](x.png)` /
   * `![[x.png]]`) points at.
   *
   * The Embed decoration seeds a SYNCHRONOUS Attachment corpus from this, for
   * the same reason `listConceptPaths` exists: CodeMirror decorations cannot
   * await, so name-resolving `![[name.png]]` needs the whole candidate set in
   * hand, not a per-Embed query. It is refreshed alongside the concept-path set
   * on `onFileChanged` and on Concept switch (`$lib/state/index.svelte.ts`).
   *
   * **A separate list, NOT a filter over `listConceptPaths`.** The two corpora
   * are disjoint by construction, in Rust (`Index::attachment_paths` vs
   * `Index::concept_paths`) and in the fake alike. `listConceptPaths` also feeds
   * the Explorer tree, Quick nav, the Wikilink candidate set and the wasm
   * `BundleIndex`, and every one of those must stay `.md`-only; a combined list
   * would make that hold only as long as five separate consumers each remember
   * to filter. Keeping the lists apart makes "no Attachment in the tree" true by
   * construction. See the Attachment-index note in
   * `crates/sunstone-native/src/index.rs`.
   */
  listAttachmentPaths(): Promise<string[]>;

  /**
   * The URL an `<img>` can load for the **Attachment** at `path` — the image
   * file an Embed (`![alt](x.png)` / `![[x.png]]`) points at. `path` is
   * bundle-relative, forward-slash, like every path on this seam; each shell
   * supplies its own scheme (ADR-0011):
   *   - `tauri.ts` — `sunstone-asset://localhost/<path>`, resolved per request
   *     against the live `Session` in Rust;
   *   - `http.ts`  — `/_api/asset?path=…`, same-origin behind the `/_api` proxy;
   *   - `fake.ts`  — a `data:` URL from the in-memory fixture (the desktop
   *     Playwright suite serves a static SPA with no file server).
   *
   * **SYNCHRONOUS on purpose — do NOT "fix" this to a Promise.** Every other
   * method here is async because it does I/O; this one does none. It is pure
   * string construction, and it is called from a CodeMirror decoration builder,
   * which CANNOT await — exactly as `broken-links.ts` resolves link targets
   * synchronously through the wasm `indexStore` rather than querying the
   * backend per link. Making it async would force the Embed widget to render
   * empty and patch itself in later, on every keystroke that rebuilds
   * decorations.
   *
   * Total: it never throws and never checks existence. A path with no
   * Attachment behind it still yields a URL; the miss surfaces as the `<img>`
   * failing to load, which the widget renders as its error placeholder.
   */
  attachmentUrl(path: string): string;

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

/**
 * Upper bound a desktop close waits for {@link Backend.onBeforeClose}'s flush.
 * Autosave writes are local file writes (milliseconds); this only matters if a
 * write hangs, in which case closing wins over waiting.
 */
export const CLOSE_FLUSH_TIMEOUT_MS = 2000;
