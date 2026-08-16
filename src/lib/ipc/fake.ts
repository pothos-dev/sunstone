import type { Backend } from './backend';
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
import {
  FAKE_BUNDLE_ROOT,
  FILES,
  COMMITTED_FILES,
  FOLDERS,
  conceptPaths,
  isSafePath,
  folderExists,
} from './fake/store';
import { buildTree, applyRename, applyDelete } from './fake/tree';
import { openPrintTab, noSavePdf, openExternalTab } from './browserShell';
import { renderConcept as renderConceptFake } from './fake/render';
import { outboundLinks, planRewrites } from './fake/links';
import { stripTagsFromFrontmatter } from './fake/frontmatter';
import { FAKE_COMMITS, committedContentAt } from './fake/git';
import { searchFiles } from './fake/search';
import {
  isLauncherForced,
  getFakeOpenBundle,
  setFakeOpenBundle,
  loadKnownBundles,
  saveKnownBundles,
  touchKnownBundle,
} from './fake/launcher';
// The index-parse kernels are pure wasm FREE exports (ADR 0006 §11-A); the fake
// consumes the single shared source rather than a divergent TS twin.
import { parseFrontmatter, parseFrontmatterKeys, rewriteAnchors } from '$lib/wasm/exports';
import { loadBundleState, saveBundleState } from './bundleState';

/**
 * In-memory Backend implementation over a seeded fixture Bundle.
 *
 * This is what makes the frontend runnable + screenshottable in plain Chromium
 * under Playwright with no native build. It must be behaviourally faithful to
 * the real backend: same path conventions (bundle-relative, '/'-separated),
 * same tree shape, same path-escape rejection.
 *
 * The fixture, mutable in-memory state, and the focused operations over it live
 * in `./fake/*`:
 *   - `fixture` — the seeded markdown fixture literal (imported only by `store`);
 *   - `store`   — the shared mutable `FILES`/`FOLDERS`/`COMMITTED_FILES` state
 *                 (exported as live bindings, so every module shares one copy)
 *                 plus the path predicates over them;
 *   - `tree`    — TreeNode construction + path-mutating rename/delete;
 *   - `frontmatter` — the test-only `stripTagsFromFrontmatter` affordance (the
 *                 index-parse kernels are wasm FREE exports, `$lib/wasm/exports`);
 *   - `links`   — outbound-link extraction + the rename/move link-rewrite engine;
 *   - `git`     — the canned commit history + committed-content-at-rev fixture;
 *   - `search`  — the capped full-text search over the fixture;
 *   - `launcher` — the localStorage/sessionStorage-backed launcher store.
 * This module wires them into the watcher-subscriber model and the exported
 * `fakeBackend`.
 */

// ---------------------------------------------------------------------------
// Simulated filesystem-change subscribers (the fake's stand-in for the Rust
// `notify` watcher).
// ---------------------------------------------------------------------------

/** Subscribers to simulated filesystem changes (see `onFileChanged`). */
const fileChangeSubscribers = new Set<(change: FileChange) => void>();

/** Subscribers to simulated git sync-loop notices (see `onSyncNotice`). */
const syncNoticeSubscribers = new Set<(notice: SyncNotice) => void>();

/**
 * Ensure the wasm module is initialized before an index query computes over the
 * shared kernels (ADR 0006 family 12). The native backend's index is ALWAYS
 * ready; the fake — the desktop backend — must be too, but its Layer-1 kernels
 * now live in wasm (link resolution + `parseFrontmatter`). An index query can be
 * driven (e.g. the Backlinks panel, a direct `__sunstoneBackend` test hook)
 * before `indexStore.refresh()` has finished its own memoized `ensureWasm()`, so
 * the fake awaits the SAME init here — otherwise the free-export wrappers degrade
 * to their empty defaults and the query returns nothing.
 *
 * `ensureWasm` (and its `$app/environment` import) is reached by a
 * `window`-guarded DYNAMIC import so the `bun test` graph — which byte-loads the
 * module up front via `bunTestSetup.ts` and runs with no `window` — never pulls
 * the SvelteKit-only `$app` virtual module in (matching `wasm/exports.ts`).
 */
async function ensureIndexReady(): Promise<void> {
  if (typeof window === 'undefined') return; // bun test: the preload registered it.
  const { ensureWasm } = await import('$lib/wasm');
  await ensureWasm();
}

/**
 * Test hook: simulate an EXTERNAL filesystem change (as if another tool edited
 * the bundle), updating the in-memory fixture and notifying subscribers. This
 * is the fake's stand-in for the Rust `notify` watcher — it lets Playwright
 * exercise the tree-refresh / reload-open-Concept path. Unlike `writeConcept`
 * (Sunstone's own autosave), these changes ARE delivered to subscribers.
 *
 * Exposed on `window.__sunstoneFake` so tests can drive it from the browser.
 */
function simulateExternalChange(
  kind: FileChange['kind'],
  path: string,
  content?: string,
): void {
  if (kind === 'removed') {
    delete FILES[path];
  } else if (content !== undefined) {
    FILES[path] = content;
  }
  notifyFsChange(kind, path);
}

/**
 * Notify subscribers of an already-applied change (the caller mutated FILES /
 * FOLDERS first). Used by the tree-CRUD ops, which — unlike `writeConcept` —
 * DO deliver to subscribers so the tree + index refresh.
 */
function notifyFsChange(kind: FileChange['kind'], path: string): void {
  for (const cb of fileChangeSubscribers) {
    cb({ kind, paths: [path] });
  }
}

/**
 * Rename/move `from`->`to`, auto-rewriting affected links. Plans the rewrites
 * from the PRE-move snapshot, performs the rename, applies the rewritten content
 * at the new locations, notifies subscribers, and returns the summary. Mirrors
 * the Rust `rename_and_rewrite` ordering exactly.
 */
function renameAndRewrite(from: string, to: string): RewriteSummary {
  // 1. Plan from the pre-move snapshot.
  const { summary, writes } = planRewrites(from, to);
  // 2. Perform the rename (mutates FILES + FOLDERS, validates existence).
  applyRename(from, to);
  // 3. Apply rewritten content at the NEW locations.
  for (const [path, content] of writes) FILES[path] = content;
  // 4. A rename is a remove of the old path + create of the new one.
  notifyFsChange('removed', from);
  notifyFsChange('created', to);
  return summary;
}

/**
 * Test hook: strip the `tags` frontmatter from EVERY Concept so the Bundle
 * carries no tags, then notify subscribers (one `modified` per affected file).
 * Drives the empty-Bundle case for hide-tags-section-when-empty, where the
 * default fixture otherwise always has tags. Mirrors the real index refresh:
 * the tag-removal arrives as ordinary file-changed events, bumping the index
 * `version`.
 */
function clearAllTags(): void {
  for (const path of conceptPaths()) {
    const stripped = stripTagsFromFrontmatter(FILES[path]);
    if (stripped !== null) {
      FILES[path] = stripped;
      notifyFsChange('modified', path);
    }
  }
}

/**
 * Test hook: drive a git sync-loop divergence notice (git-sync spec §10.2), as
 * if the server's loop had just forked a conflicting web version or dropped a web
 * deletion. There is no loop in the fake — and no filesystem effect is simulated
 * (the fork file's appearance is an ordinary watcher change, drivable separately
 * via `simulateExternalChange`) — this is purely the notice channel, so Playwright
 * can assert the dismissible notice for BOTH kinds.
 *
 * Exposed on `window.__sunstoneFake` alongside `simulateExternalChange`.
 */
function simulateSyncNotice(notice: SyncNotice): void {
  for (const cb of syncNoticeSubscribers) {
    cb(notice);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__sunstoneFake = {
    simulateExternalChange,
    simulateSyncNotice,
    clearAllTags,
    files: FILES,
  };
}

export const fakeBackend: Backend = {
  async bundleRoot(): Promise<string> {
    return FAKE_BUNDLE_ROOT;
  },

  // --- Launcher seam (in-browser stand-in for the runtime Bundle switch) ------
  // With no Tauri process there is nothing to actually swap, so the fake models
  // the launcher over web storage: `?launcher=1` in the URL forces launcher mode
  // (currentBundle → null) until a folder is "opened", after which openBundle
  // marks the fixture Bundle open (surviving the reload the launcher triggers).
  // The known-folder list lives in localStorage (seeded so the list is non-empty
  // for tests/screenshots); forget removes an entry; the picker returns a canned
  // path (no native chooser under plain Chromium).

  async currentBundle(): Promise<string | null> {
    // Not in forced-launcher mode: behave as before (a Bundle is always open),
    // so every existing test keeps rendering the editor.
    if (!isLauncherForced()) return FAKE_BUNDLE_ROOT;
    // Forced launcher mode: open only once a folder has been picked this session.
    return getFakeOpenBundle();
  },

  async listKnownBundles(): Promise<KnownBundle[]> {
    return loadKnownBundles();
  },

  async forgetBundle(path: string): Promise<void> {
    saveKnownBundles(loadKnownBundles().filter((b) => b.path !== path));
  },

  async openBundle(path: string): Promise<void> {
    touchKnownBundle(path);
    setFakeOpenBundle(path);
  },

  async pickFolder(): Promise<string | null> {
    // No native chooser in plain Chromium: return a deterministic new path so the
    // "Open folder…" flow is still exercisable end-to-end under Playwright.
    return '/home/user/New Bundle';
  },

  async listTree(): Promise<TreeNode> {
    // Rebuild each call so created/removed files (via writeConcept or a
    // simulated external change) are reflected, like the real walker.
    return buildTree();
  },

  async readConcept(path: string): Promise<string> {
    if (!isSafePath(path)) {
      throw new Error(`path escapes the bundle: ${path}`);
    }
    const content = FILES[path];
    if (content === undefined) {
      throw new Error(`no such concept: ${path}`);
    }
    return content;
  },

  async writeConcept(path: string, content: string): Promise<void> {
    if (!isSafePath(path)) {
      throw new Error(`path escapes the bundle: ${path}`);
    }
    // Sunstone's own write: update the in-memory bundle but do NOT notify
    // subscribers — the real backend suppresses the watcher echo for self
    // writes, and the fake must be behaviourally faithful (no reload loop).
    FILES[path] = content;
  },

  onFileChanged(cb: (change: FileChange) => void): () => void {
    fileChangeSubscribers.add(cb);
    return () => {
      fileChangeSubscribers.delete(cb);
    };
  },

  // Emitter-backed (git-sync spec §10.3) so Playwright can drive both notice
  // kinds through `window.__sunstoneFake.simulateSyncNotice`; nothing else in the
  // fake ever emits one.
  onSyncNotice(cb: (notice: SyncNotice) => void): () => void {
    syncNoticeSubscribers.add(cb);
    return () => {
      syncNoticeSubscribers.delete(cb);
    };
  },

  // --- Tree CRUD (slice: tree-crud) ---
  // Mutate the in-memory fixture, then notify subscribers — structural changes
  // SHOULD refresh the tree + index (unlike `writeConcept`, which is Sunstone's
  // own autosave and is suppressed). This mirrors the real backend, where these
  // ops are NOT recorded as self-writes so the watcher's `file-changed` fires.

  async createConcept(path: string): Promise<void> {
    if (!isSafePath(path)) throw new Error(`path escapes the bundle: ${path}`);
    if (!path.endsWith('.md')) throw new Error(`a Concept path must end in .md: ${path}`);
    if (Object.prototype.hasOwnProperty.call(FILES, path)) {
      throw new Error(`already exists: ${path}`);
    }
    // Mirror the Rust `create_concept`: the parent folder must already exist
    // (there, the `fs::write` fails otherwise). `''` = Bundle root, always OK.
    const slash = path.lastIndexOf('/');
    const parent = slash === -1 ? '' : path.slice(0, slash);
    if (parent !== '' && !folderExists(parent)) {
      throw new Error(`parent folder does not exist: ${path}`);
    }
    FILES[path] = '';
    notifyFsChange('created', path);
  },

  async createFolder(path: string): Promise<void> {
    if (!isSafePath(path)) throw new Error(`path escapes the bundle: ${path}`);
    if (path === '') throw new Error('path must not be empty');
    if (folderExists(path)) throw new Error(`already exists: ${path}`);
    FOLDERS.add(path);
    notifyFsChange('created', path);
  },

  async renamePath(from: string, to: string): Promise<RewriteSummary> {
    if (!isSafePath(from) || !isSafePath(to)) {
      throw new Error('path escapes the bundle');
    }
    return renameAndRewrite(from, to);
  },

  async movePath(from: string, toDir: string): Promise<RewriteSummary> {
    if (!isSafePath(from) || (toDir !== '' && !isSafePath(toDir))) {
      throw new Error('path escapes the bundle');
    }
    const name = from.split('/').filter(Boolean).pop();
    if (!name) throw new Error(`invalid source path: ${from}`);
    const to = toDir === '' ? name : `${toDir.replace(/\/+$/, '')}/${name}`;
    if (to === from) throw new Error(`already in that folder: ${from}`);
    return renameAndRewrite(from, to);
  },

  async deletePath(path: string): Promise<void> {
    if (!isSafePath(path)) throw new Error(`path escapes the bundle: ${path}`);
    const removed = applyDelete(path);
    if (removed.length === 0) throw new Error(`no such path: ${path}`);
    for (const p of removed) notifyFsChange('removed', p);
  },

  async rewriteAnchors(target: string, renames: AnchorRename[]): Promise<RewriteSummary> {
    if (!isSafePath(target)) throw new Error(`path escapes the bundle: ${target}`);
    if (renames.length === 0) return { linksChanged: 0, filesChanged: 0 };
    const allPaths = conceptPaths();
    let linksChanged = 0;
    let filesChanged = 0;
    // Rewrite every inbound source except the target itself (its own same-file
    // anchors are handled in the open buffer). Silent, like `writeConcept`: the
    // real backend records these as self-writes; anchors don't affect the index
    // (resolution ignores them), so no refresh is needed.
    for (const source of allPaths) {
      if (source === target) continue;
      const content = FILES[source];
      if (content === undefined) continue;
      const { content: rewritten, count } = rewriteAnchors(
        source,
        content,
        target,
        renames,
        allPaths,
      );
      if (count > 0) {
        FILES[source] = rewritten;
        linksChanged += count;
        filesChanged++;
      }
    }
    return { linksChanged, filesChanged };
  },

  async listConceptPaths(): Promise<string[]> {
    return conceptPaths();
  },

  async conceptExists(path: string): Promise<boolean> {
    return path.endsWith('.md') && Object.prototype.hasOwnProperty.call(FILES, path);
  },

  async backlinks(path: string): Promise<string[]> {
    await ensureIndexReady();
    const sources: string[] = [];
    for (const source of conceptPaths()) {
      if (outboundLinks(source, FILES[source]).includes(path)) {
        sources.push(source);
      }
    }
    return sources.sort();
  },

  async allTags(): Promise<TagCount[]> {
    await ensureIndexReady();
    const counts = new Map<string, number>();
    for (const path of conceptPaths()) {
      const { tags } = parseFrontmatter(FILES[path]);
      // De-dupe within a Concept so a repeated tag counts once.
      for (const tag of new Set(tags)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  },

  async conceptsByTag(tag: string): Promise<string[]> {
    await ensureIndexReady();
    const out: string[] = [];
    for (const path of conceptPaths()) {
      const { tags } = parseFrontmatter(FILES[path]);
      if (tags.includes(tag)) out.push(path);
    }
    return out.sort();
  },

  async allTypes(): Promise<string[]> {
    await ensureIndexReady();
    const set = new Set<string>();
    for (const path of conceptPaths()) {
      const { type } = parseFrontmatter(FILES[path]);
      if (type !== null && type !== '') set.add(type);
    }
    return [...set].sort();
  },

  async allKeys(): Promise<string[]> {
    await ensureIndexReady();
    const set = new Set<string>();
    for (const path of conceptPaths()) {
      for (const key of parseFrontmatterKeys(FILES[path])) set.add(key);
    }
    return [...set].sort();
  },

  // Per-Bundle session state, backed by `localStorage` keyed by the fake bundle
  // path. localStorage survives a page reload, so a Playwright reload restores
  // the last-open Concept + expanded folders exactly as the real backend would
  // restore them from the OS config file. Robust to corrupt JSON (-> defaults).
  async loadBundleState(): Promise<BundleState> {
    return loadBundleState(BUNDLE_STATE_KEY);
  },

  async saveBundleState(state: BundleState): Promise<void> {
    saveBundleState(BUNDLE_STATE_KEY, state);
  },

  // Full-text search: the JS equivalent of the Rust ripgrep-crate search, capped
  // at MAX_SEARCH_RESULTS to mirror the backend's server-side cap; see
  // `./fake/search`.
  async search(query: string): Promise<SearchHit[]> {
    return searchFiles(query);
  },

  // Git seam: canned, deterministic history/content so the review-diff UI is
  // testable in plain Chromium with no git. A Concept present in the COMMITTED
  // snapshot reports a fixed two-commit history (newest first); a path created
  // at runtime (working tree only) or entirely unknown is reported `untracked`
  // — the same distinguishable state the real backend surfaces for a
  // never-committed file, so the review toggle can disable itself.
  async fileHistory(path: string): Promise<FileHistory> {
    if (!isSafePath(path)) throw new Error(`path escapes the bundle: ${path}`);
    if (!Object.prototype.hasOwnProperty.call(COMMITTED_FILES, path)) {
      return { status: 'untracked' };
    }
    return { status: 'ok', commits: FAKE_COMMITS };
  },

  async fileAtRev(path: string, rev: string): Promise<FileAtRev> {
    if (!isSafePath(path)) throw new Error(`path escapes the bundle: ${path}`);
    const content = committedContentAt(path, rev);
    if (content === null) return { status: 'notFound' };
    return { status: 'ok', content };
  },

  // Server-quality render: a minimal in-browser stand-in for the Rust renderer
  // (no comrak here). Emits CriticMarkup marks to the same `critic-*` markup so
  // the desktop print/annotation path is testable under Playwright; see
  // `./fake/render`. Path validation + missing-file behaviour mirror
  // `readConcept` (which the render reads through).
  async renderConcept(path: string): Promise<RenderPayload> {
    if (!isSafePath(path)) throw new Error(`path escapes the bundle: ${path}`);
    const content = FILES[path];
    if (content === undefined) throw new Error(`no such concept: ${path}`);
    await ensureIndexReady(); // the fake render derives outline/critic/citations from wasm.
    return renderConceptFake(content);
  },

  // Running under plain Chromium (dev / Playwright): the browser-shell
  // fallbacks shared with the http backend (see `./browserShell`).
  openPrintWindow: openPrintTab,
  savePdf: noSavePdf,
  openExternal: openExternalTab,
};

/** localStorage key for the fake Bundle's session state. */
const BUNDLE_STATE_KEY = `sunstone:bundleState:${FAKE_BUNDLE_ROOT}`;
