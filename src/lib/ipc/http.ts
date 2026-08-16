import type { Backend } from './backend';
import { isOwnEcho } from '$lib/web/concurrency';
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
 * HTTP Backend implementation for the "Sunstone Web" build target, talking to
 * the `sunstone-server` axum binary over `fetch`.
 *
 * Reads (`bundleRoot`, `listTree`, `readConcept`, the index queries, search,
 * render) are open. WRITES (`writeConcept`, Tree CRUD, `rewriteAnchors`) are the
 * authenticated, git-backed write path (ticket 07): each maps 1:1 to a server
 * write route; the `/api` hook attaches the auth JWT on writes only. A few
 * launcher/session methods are inapplicable on the web (single fixed Bundle,
 * View state client-side) and stay inert.
 *
 * Requests target relative `/api/...` (same origin). In the browser those hit
 * the SvelteKit origin and are proxied to the Rust server (see the `/api`
 * proxy in `src/hooks.server.ts`), avoiding CORS and keeping one public origin.
 * SSR reads its data directly in `+page.ts`'s `load`, so this seam is primarily
 * the hydrated-island path.
 *
 * See docs/architecture/web-frontend.md "The IPC seam" and the enable-web-writing effort.
 */

/** The web serves ONE fixed Bundle and has no launcher, so folder switching is
 * inapplicable (writing Concepts, by contrast, is now supported — see below). */
const NO_LAUNCHER = 'the web serves a single fixed Bundle: no folder switching';

/**
 * `localStorage` key for the web build's per-Bundle View state. The web serves
 * a single fixed Bundle, so one key suffices (mirrors `web/uiState.ts`'s
 * `sunstone:webUI` naming convention). NEVER committed into the Bundle — this
 * is per-user View state (docs/GLOSSARY.md).
 */
const BUNDLE_STATE_KEY = 'sunstone:bundleState';

/** Fresh-Bundle default (mirrors the Rust `BundleState::default`). */
function defaultBundleState(): BundleState {
  return { lastOpenConcept: null, expandedFolders: [], recentFiles: [] };
}

/**
 * Load the web Bundle's View state from `localStorage`. Returns the fresh
 * default on the server (SSR: no `localStorage`), a missing key, or corrupt
 * JSON — never rejects. Optional fields pass through untouched (the session
 * store defaults each on read).
 */
function loadWebBundleState(): BundleState {
  if (typeof localStorage === 'undefined') return defaultBundleState();
  const raw = localStorage.getItem(BUNDLE_STATE_KEY);
  if (raw === null) return defaultBundleState();
  try {
    const parsed = JSON.parse(raw) as Partial<BundleState>;
    return {
      ...parsed,
      lastOpenConcept: parsed.lastOpenConcept ?? null,
      expandedFolders: Array.isArray(parsed.expandedFolders) ? parsed.expandedFolders : [],
      recentFiles: Array.isArray(parsed.recentFiles) ? parsed.recentFiles : [],
    };
  } catch {
    return defaultBundleState();
  }
}

/** Persist the web Bundle's View state to `localStorage`. A no-op on the server
 * or if storage is full/disabled (best-effort — never throws into the UI). */
function saveWebBundleState(state: BundleState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(BUNDLE_STATE_KEY, JSON.stringify(state));
  } catch {
    /* storage full / disabled — best-effort, never throw */
  }
}

/**
 * This tab's write client id (ticket 08): minted once per tab, in-memory, and
 * forwarded on every web write as `x-sunstone-client`. The server stamps the
 * SSE broadcast with it so this tab drops its own echo while every other tab
 * treats the change as genuine. NOT persisted — two tabs are independent
 * writers, so each reloads on the other's write (correct last-write-wins).
 */
export const CLIENT_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** GET `url` and parse the JSON body, mapping a non-2xx to a thrown Error. */
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    // The server sends a plain-text message body for 4xx (e.g. path escapes).
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${detail || url}`);
  }
  return (await res.json()) as T;
}

/**
 * GET a *gated* git read route (`/api/history`, `/api/file-at-rev`), mapping an
 * UNAVAILABLE CAPABILITY to the seam's graceful status instead of an error
 * (git-sync spec §11).
 *
 * The mapping follows the seam's documented contract literally — **only a
 * path-escape rejects** — and that path escape is exactly the **400** spec §11.2
 * specifies:
 *   - **400** → throw (an invalid path, the one case the seam permits rejecting);
 *   - **every other failure** → `unavailable` (`{ status: 'gitMissing' }`): 401
 *     (not signed in) and 503 (no `SUNSTONE_JWT_SECRET`) from
 *     `hooks.server.ts`'s gate, 404 from a server that predates these routes,
 *     500, and a network-level throw (server down mid-session).
 *
 * This FAILS SAFE: the review-diff toggle disables itself instead of hanging on
 * "Checking git history…" forever, which is what a rejection here caused (the
 * caller leaves its state `null` on a rejected probe).
 */
async function getGatedGit<T>(url: string, unavailable: T): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    // Network-level failure (server down, connection dropped): the capability is
    // unavailable, not a caller error.
    return unavailable;
  }
  if (res.status === 400) {
    // The ONE rejection the seam permits: an invalid / escaping path.
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${detail || url}`);
  }
  if (!res.ok) return unavailable;
  try {
    return (await res.json()) as T;
  } catch {
    // A 2xx with a body we cannot parse (an unexpected proxy/HTML response) is
    // no more usable than a 404 — same graceful status, still no rejection.
    return unavailable;
  }
}

/**
 * Map a write route's HTTP status + server detail to a user-facing message
 * (ticket 07 §8 taxonomy: 400 invalid path / 409 conflict / 404 missing / 401
 * unauthenticated / 500 server). Pure so it is unit-testable; `sendJson` throws
 * an `Error` carrying this message on any non-2xx write response.
 */
export function httpWriteError(status: number, detail: string): string {
  const extra = detail.trim() ? `: ${detail.trim()}` : '';
  switch (status) {
    case 400:
      return `Invalid path${extra}`;
    case 401:
      return 'You are not signed in, or your session expired — sign in to edit.';
    case 404:
      return `Not found${extra}`;
    case 409:
      return `Conflict${extra}`;
    default:
      return `Save failed (${status})${extra}`;
  }
}

/**
 * Send a JSON write to `url` with `method`, forwarding the per-tab `clientId`.
 * A `204 No Content` resolves to `undefined`; a `200` parses its JSON body
 * (a `RewriteSummary`). A non-2xx throws with a `httpWriteError` message.
 */
async function sendJson<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-sunstone-client': CLIENT_ID,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(httpWriteError(res.status, detail));
  }
  // 204 (writeConcept/create/delete) has no body; 200 carries a RewriteSummary.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Parse one SSE `data:` payload into a `FileChange`, or `null` if it is not a
 * well-formed change (malformed JSON, or missing/typed-wrong fields). Pure so
 * it can be unit-tested; the `EventSource` handler in `onFileChanged` only
 * invokes the callback for a non-null result.
 */
export function parseFileChange(data: string): FileChange | null {
  try {
    const raw = JSON.parse(data) as Partial<FileChange>;
    if (
      (raw.kind === 'created' || raw.kind === 'modified' || raw.kind === 'removed') &&
      Array.isArray(raw.paths) &&
      raw.paths.every((p) => typeof p === 'string')
    ) {
      const change: FileChange = { kind: raw.kind, paths: raw.paths };
      // A web write carries an `origin` stamp (clientId + author); external /
      // desktop edits omit it. Carry it through only when well-formed.
      const origin = raw.origin;
      if (
        origin &&
        typeof origin.clientId === 'string' &&
        origin.author &&
        typeof origin.author.name === 'string'
      ) {
        change.origin = { clientId: origin.clientId, author: { name: origin.author.name } };
      }
      return change;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Parse one `sync` SSE `data:` payload into a `SyncNotice`, or `null` if it is
 * not a well-formed notice (git-sync spec §10.2). Pure so it can be unit-tested;
 * the `addEventListener('sync', …)` bridge in `onSyncNotice` only invokes the
 * callback for a non-null result. A `forked` notice without a `fork` path carries
 * nothing actionable, so it is dropped rather than rendered half-formed.
 */
export function parseSyncNotice(data: string): SyncNotice | null {
  try {
    const raw = JSON.parse(data) as Partial<SyncNotice> & { fork?: unknown };
    if (typeof raw.path !== 'string') return null;
    if (raw.kind === 'forked' && typeof raw.fork === 'string') {
      return { kind: 'forked', path: raw.path, fork: raw.fork };
    }
    if (raw.kind === 'deletionDropped') {
      return { kind: 'deletionDropped', path: raw.path };
    }
  } catch {
    /* fall through */
  }
  return null;
}

// --- The ONE `/api/events` connection, shared by both event streams. ---------
// `/api/events` multiplexes two SSE streams over a single connection: unnamed
// `message` events carrying a `FileChange` (the watcher) and named `sync` events
// carrying a `SyncNotice` (the git sync loop, git-sync spec §10.3). Both seam
// subscriptions ride THIS source — a second `EventSource` would buy a second
// connection + keep-alive for what the event name gives free.
//
// Handlers are attached with `addEventListener` (not `onmessage =`) precisely
// because the source is shared: assignment would let a second subscriber clobber
// the first's handler, and an unsubscribe could not detach just its own.
let eventSource: EventSource | null = null;
let eventRefs = 0;

/** Open (or join) the shared `/api/events` connection; `null` under SSR. */
function acquireEvents(): EventSource | null {
  if (typeof EventSource === 'undefined') return null; // SSR / non-browser
  if (!eventSource) eventSource = new EventSource('/api/events');
  eventRefs += 1;
  return eventSource;
}

/** Release one reference; the last one out closes the connection. */
function releaseEvents(): void {
  eventRefs = Math.max(0, eventRefs - 1);
  if (eventRefs === 0 && eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

export const httpBackend: Backend = {
  bundleRoot(): Promise<string> {
    return getJson<string>('/api/bundle-root');
  },

  // Launcher seam: the web build always serves a single, fixed Bundle and has no
  // launcher UI, so `currentBundle` reports that Bundle as open and the rest are
  // inert (never reached by the web viewer).
  currentBundle(): Promise<string | null> {
    return getJson<string>('/api/bundle-root');
  },
  listKnownBundles(): Promise<KnownBundle[]> {
    return Promise.resolve([]);
  },
  forgetBundle(_path: string): Promise<void> {
    return Promise.reject(new Error(NO_LAUNCHER));
  },
  openBundle(_path: string): Promise<void> {
    return Promise.reject(new Error(NO_LAUNCHER));
  },
  pickFolder(): Promise<string | null> {
    return Promise.resolve(null);
  },

  listTree(): Promise<TreeNode> {
    return getJson<TreeNode>('/api/tree');
  },

  readConcept(path: string): Promise<string> {
    return getJson<string>(`/api/concept?path=${encodeURIComponent(path)}`);
  },

  // --- Write path (ticket 07): authenticated, git-backed, commit-per-op. -----
  // Each maps 1:1 to a `sunstone-server` write route; the `/api` hook attaches
  // the auth JWT (writes only). `x-sunstone-client` carries this tab's clientId
  // so the SSE echo of our own write is dropped (see `onFileChanged`). Errors
  // surface via `httpWriteError` (401/400/404/409/500).
  writeConcept(path: string, content: string): Promise<void> {
    return sendJson<void>('PUT', '/api/concept', { path, content });
  },
  createConcept(path: string): Promise<void> {
    return sendJson<void>('POST', '/api/concept', { path });
  },
  createFolder(path: string): Promise<void> {
    return sendJson<void>('POST', '/api/folder', { path });
  },
  renamePath(from: string, to: string): Promise<RewriteSummary> {
    return sendJson<RewriteSummary>('POST', '/api/rename', { from, to });
  },
  movePath(from: string, toDir: string): Promise<RewriteSummary> {
    return sendJson<RewriteSummary>('POST', '/api/move', { from, toDir });
  },
  deletePath(path: string): Promise<void> {
    return sendJson<void>('DELETE', `/api/concept?path=${encodeURIComponent(path)}`);
  },
  rewriteAnchors(target: string, renames: AnchorRename[]): Promise<RewriteSummary> {
    return sendJson<RewriteSummary>('POST', '/api/rewrite-anchors', { target, renames });
  },

  // `saveBundleState` is off the server write surface (ticket 07 §6): it is
  // per-user *View state*, never committed into the shared Bundle. On the web it
  // is a purely client-side concern, so we round-trip it through `localStorage`
  // (see `loadBundleState` / `saveWebBundleState`), SSR-safe.
  saveBundleState(state: BundleState): Promise<void> {
    saveWebBundleState(state);
    return Promise.resolve();
  },

  // --- Filesystem change events over SSE (`/api/events`). -------------------
  // Every connected browser live-updates when Concepts change on disk (edited
  // by any external tool — the web app never writes). `EventSource` targets the
  // relative `/api/events` (proxied to the Rust server, streamed un-buffered);
  // it auto-reconnects on a dropped connection. The returned unsubscribe is
  // synchronous (matching the seam contract): it closes the stream at once.
  onFileChanged(cb: (change: FileChange) => void): () => void {
    // No EventSource under SSR / non-browser — nothing to subscribe to.
    const source = acquireEvents();
    if (!source) return () => {};
    const handler = (e: MessageEvent) => {
      const change = parseFileChange(typeof e.data === 'string' ? e.data : '');
      // Drop the echo of THIS tab's own write (ticket 08 §1): we already have
      // that content. Every other client sees it as a genuine change.
      if (change && !isOwnEcho(change, CLIENT_ID)) cb(change);
    };
    source.addEventListener('message', handler);
    return () => {
      source.removeEventListener('message', handler);
      releaseEvents();
    };
  },

  // --- Git sync-loop divergence notices (git-sync spec §10.3). ---------------
  // The loop sends `event: sync` frames on the SAME `/api/events` stream;
  // `EventSource` dispatches a named event ONLY to a matching listener, so the
  // unnamed `message` channel above (and `parseFileChange`, and the `FileChange`
  // type) is untouched. No second connection, no polling.
  onSyncNotice(cb: (notice: SyncNotice) => void): () => void {
    const source = acquireEvents();
    if (!source) return () => {};
    const handler = (e: MessageEvent) => {
      const notice = parseSyncNotice(typeof e.data === 'string' ? e.data : '');
      // Broadcast to every client and un-attributed, so there is no echo to drop.
      if (notice) cb(notice);
    };
    source.addEventListener('sync', handler as EventListener);
    return () => {
      source.removeEventListener('sync', handler as EventListener);
      releaseEvents();
    };
  },

  // --- Index-backed read queries over the proxied `/api/...` routes. --------
  // Back the read-only sidebar Sections (Backlinks, Tags) served by the core
  // in-memory index. Paths crossing the seam are bundle-relative, forward-slash.
  listConceptPaths(): Promise<string[]> {
    return getJson<string[]>('/api/concept-paths');
  },
  conceptExists(path: string): Promise<boolean> {
    return getJson<boolean>(`/api/concept-exists?path=${encodeURIComponent(path)}`);
  },
  backlinks(path: string): Promise<string[]> {
    return getJson<string[]>(`/api/backlinks?path=${encodeURIComponent(path)}`);
  },
  allTags(): Promise<TagCount[]> {
    return getJson<TagCount[]>('/api/tags');
  },
  conceptsByTag(tag: string): Promise<string[]> {
    return getJson<string[]>(`/api/concepts-by-tag?tag=${encodeURIComponent(tag)}`);
  },

  // New-concept `type` autocomplete + Properties key autocomplete, served by
  // the core in-memory index over the read-only `/api/types` + `/api/keys`
  // routes (the OKF recommended keys are merged in client-side).
  allTypes(): Promise<string[]> {
    return getJson<string[]>('/api/types');
  },
  allKeys(): Promise<string[]> {
    return getJson<string[]>('/api/keys');
  },
  loadBundleState(): Promise<BundleState> {
    return Promise.resolve(loadWebBundleState());
  },

  // Bundle-wide full-text search over the proxied `/api/search` (backed by the
  // core ripgrep search: case-insensitive literal, ordered by path then line,
  // capped server-side). An empty/whitespace query yields `[]` (no scan).
  search(query: string): Promise<SearchHit[]> {
    return getJson<SearchHit[]>(`/api/search?q=${encodeURIComponent(query)}`);
  },

  // Git seam over the two SESSION-GATED read routes (git-sync spec §11):
  // `fileAtRev` returns the full text of any path at any revision — including
  // content deliberately deleted from the Bundle — so both routes take the same
  // session→mint-JWT→forward branch as a write (`hooks.server.ts`'s
  // `GATED_READS`). A signed-out visitor is answered 401 there and a server with
  // no auth wired 503; `getGatedGit` folds those — and every other failure short
  // of a 400 path escape — into the seam's graceful `gitMissing`, so the shared
  // review-diff UI just disables its toggle instead of surfacing an error or
  // hanging. The server maps git's own outcomes 1:1 (`notARepo` / `untracked` /
  // `noHistory` / `gitMissing`); only a path escape (400) rejects.
  fileHistory(path: string): Promise<FileHistory> {
    return getGatedGit<FileHistory>(`/api/history?path=${encodeURIComponent(path)}`, {
      status: 'gitMissing',
    });
  },
  fileAtRev(path: string, rev: string): Promise<FileAtRev> {
    return getGatedGit<FileAtRev>(
      `/api/file-at-rev?path=${encodeURIComponent(path)}&rev=${encodeURIComponent(rev)}`,
      { status: 'gitMissing' },
    );
  },

  // Server-quality render over the proxied `/api/render` — the same route the
  // web viewer's `loadConcept` uses (body HTML + frontmatter + outline). Paths
  // are bundle-relative, forward-slash.
  renderConcept(path: string): Promise<RenderPayload> {
    return getJson<RenderPayload>(`/api/render?path=${encodeURIComponent(path)}`);
  },

  // The web viewer opens its own chrome-free print tab directly (no toolbar,
  // relying on the browser's native print → Save-as-PDF UI), so this seam is
  // unused on web; implemented for interface parity as a new tab WITH toolbar.
  async openPrintWindow(path: string): Promise<void> {
    window.open(`/?print=${encodeURIComponent(path)}&toolbar=1`, '_blank');
  },

  // The web viewer relies on the browser's native print → Save-as-PDF, so direct
  // export has no server-side counterpart; resolve to `null` (no file written).
  async savePdf(_defaultName: string): Promise<string | null> {
    return null;
  },

  // On the web the app already runs in the browser, so a new tab IS the default
  // application; open it directly.
  async openExternal(url: string): Promise<void> {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
};
