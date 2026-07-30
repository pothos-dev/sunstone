<script lang="ts">
  // Client-only island that mounts the FULL desktop `App.svelte` shell on the
  // web for an AUTHENTICATED user (WP0) AND hosts the web write-concurrency
  // coordinator (WP3, ticket 08). `App.svelte` (and, transitively, CodeMirror)
  // is NEVER statically imported — it is pulled in via a dynamic `import()`
  // behind an `onMount` guard, so it stays out of both the SSR graph and the web
  // client's initial chunk. Until it resolves we show a "Loading workspace…" state.
  //
  // The coordinator is a THIN switch over the pure `concurrency.ts` helpers and
  // the `editor` module singleton (the SAME active-Tile/Document model `App`
  // drives). It owns four web-only concerns — all guarded on `__SUNSTONE_WEB__`
  // so the desktop shell is byte-identical:
  //   1. SSE routing — the SINGLE `onFileChanged` handler (App's own subscription
  //      is web-gated off), routing the active buffer through refresh / clean
  //      reload / dirty conflict / deleted, and refreshing the read-only surfaces.
  //   2. Explicit Save — Cmd/Ctrl+S flushes the active Document (one commit);
  //      the visible Save button lives in the per-Tile header (shown while
  //      editing + dirty). Web blur-flush is suppressed in Tile, so persistence
  //      is explicit-only.
  //   3. Dirty-leave gate — registered on the workspace so a Concept switch / Tile
  //      close over a dirty buffer routes through the three-way leave modal.
  //   4. Structural-op gate — registered on `treeActions` so a rename/move/delete
  //      over a dirty buffer routes through the three-way structural modal.
  //   5. `beforeunload` guard — armed only while the active buffer is dirty.
  //   6. Sync notices — the server sync loop's two divergence events (a fork
  //      created / a web deletion dropped), rendered as DISMISSIBLE notices.
  //   7. URL ⇄ Concept sync — the address bar always names the Concept on screen
  //      (see `urlSync.ts`), so a reload / copied link / browser Back-Forward
  //      lands on it. Web-only: it is what makes splitting web-disabled.
  import { onMount } from 'svelte';
  import type { Component } from 'svelte';
  import { page } from '$app/state';
  import { pushState, replaceState } from '$app/navigation';
  import { backend } from '$lib/ipc';
  import { bundle } from '$lib/state/bundle.svelte';
  import { editor } from '$lib/state/editor.svelte';
  import { indexStore } from '$lib/state/index.svelte';
  import { session } from '$lib/state/session.svelte';
  import { treeActions } from '$lib/state/treeActions.svelte';
  import { setDirtyLeaveGate } from '$lib/state/workspace.svelte';
  import type { Document } from '$lib/state/document.svelte';
  import type { FileChange, SyncNotice } from '$lib/types';
  import { routeFileChange, structuralOpGated, type GatedStructuralOp } from './concurrency';
  import { matchesHotkey } from '$lib/matchesHotkey';
  import { conceptHref, urlSyncAction } from './urlSync';
  import WebConcurrencyModals from './WebConcurrencyModals.svelte';
  import type { PendingSyncNotice } from './WebConcurrencyModals.svelte';
  import UserMenu from './UserMenu.svelte';
  import type { WebUser } from './loadConcept';

  interface Props {
    /** bundle-relative path of the SSR-selected Concept (forward-slash), or null. */
    selected: string | null;
    /** The authenticated user (for the rail's avatar / sign-out menu). */
    user: WebUser | null;
    /**
     * Called with the active Tile's Concept whenever the shell navigates, so the
     * host (`WebViewer`) can keep the document `<title>` in step — the SSR `load`
     * does not re-run for the shell's shallow URL updates.
     */
    onConcept?: (path: string | null) => void;
  }

  let { selected, user, onConcept }: Props = $props();

  // Sign out via the Auth.js client helper (does the /auth/csrf round-trip + the
  // POST /auth/signout, then a full-page redirect that re-lands on the anon read
  // surface). Lazy-imported so the auth client stays out of the SSR + initial
  // client graph. A dirty buffer is caught by the `beforeunload` guard below,
  // exactly like a tab close.
  async function signOut(): Promise<void> {
    const { signOut: doSignOut } = await import('@auth/sveltekit/client');
    await doSignOut({ callbackUrl: '/' });
  }

  // The lazily-loaded desktop App shell, resolved in `onMount` (client only) so
  // nothing here is import-time heavy.
  let AppComponent = $state<Component | null>(null);

  function basename(p: string): string {
    const last = p.split('/').pop() ?? p;
    return last.replace(/\.md$/, '');
  }

  // --- (7) URL ⇄ Concept sync (web-only; rule + rationale in `urlSync.ts`) ----
  // The address bar is a projection of the single Tile's Concept. `page.state`
  // carries the Concept path itself, so Back/Forward over our shallow entries
  // needs no path re-resolution — and, being shallow, re-runs no route `load`
  // (no SSR round-trip, no re-mount of this island).
  //
  // Runs once the initial restore has settled (`session.restored`) — that is the
  // point App has opened `selected` into the single Tile. Before it the Tile is
  // legitimately empty and syncing would rewrite the URL to the Bundle root.
  let syncedConcept: string | null = null;
  /** True while a URL-driven (Back/Forward) open is loading; see `urlSyncAction`. */
  let openingFromUrl = $state(false);

  $effect(() => {
    // Read both sides + the in-flight flag unconditionally, so this effect tracks
    // all three however it exits below.
    const urlConcept = page.state.concept;
    const appConcept = editor.path;
    const inFlight = openingFromUrl;
    if (!__SUNSTONE_WEB__ || !session.restored) return;

    const action = urlSyncAction(syncedConcept, urlConcept, appConcept, inFlight);
    if (action.kind === 'idle') return;
    syncedConcept = action.concept;
    onConcept?.(action.concept);

    if (action.kind === 'stamp') {
      // An unstamped entry (the SSR one we landed on, or one whose state a real
      // navigation wiped): mark it with what the Tile holds, keeping the URL.
      replaceState('', { concept: action.concept });
      return;
    }

    if (action.kind === 'url') {
      // The app navigated → project it onto the URL. A new history entry, so the
      // browser's Back walks the Concepts the user visited. (The Tile keeps its
      // own history too: using ITS Back also appends an entry here, which is why
      // the two never desync — every move, whoever made it, lands in the URL.)
      pushState(conceptHref(action.concept), { concept: action.concept });
      return;
    }

    // The URL navigated → follow it in the Tile. `null` (the Bundle root with no
    // `index.md`) clears the Tile to its empty state. A dirty buffer routes
    // through the leave gate; a CANCEL leaves the Tile put and the next reconcile
    // writes the URL back to it.
    openingFromUrl = true;
    void (action.concept === null ? editor.close() : editor.open(action.concept)).finally(() => {
      openingFromUrl = false;
    });
  });

  // --- Concurrency surfaces (all thin over concurrency.ts) --------------------
  let conflict = $state<{ author: string | null } | null>(null);
  let deleted = $state<{ author: string | null } | null>(null);
  let updated = $state<{ author: string | null; id: number } | null>(null);
  let updatedSeq = 0;
  // The three-way modals carry the outgoing Document + a resolver back into the
  // workspace / treeActions gate promise.
  let leave = $state<{ doc: Document; resolve: (proceed: boolean) => void } | null>(null);
  let structural = $state<{
    op: GatedStructuralOp;
    target: string;
    doc: Document;
    resolve: (proceed: boolean) => void;
  } | null>(null);

  // Concept name for the active modal (only one shows at a time). Leave/structural
  // name their outgoing buffer; conflict/deleted name the active Concept.
  const conceptName = $derived(
    basename(leave?.doc.path ?? structural?.doc.path ?? editor.path ?? ''),
  );

  // Debounce a burst of external changes into a single (re-)raise of the blocking
  // conflict dialog (ticket 08 §3); "Keep my changes" clears it, a further genuine
  // change re-raises.
  let conflictBurst: ReturnType<typeof setTimeout> | null = null;
  function raiseConflict(author: string | null): void {
    if (conflictBurst) clearTimeout(conflictBurst);
    conflictBurst = setTimeout(() => {
      conflict = { author };
      conflictBurst = null;
    }, 120);
  }

  function showUpdatedNotice(author: string | null): void {
    updated = { author, id: ++updatedSeq };
  }

  // Auto-dismiss the non-blocking "updated" notice a few seconds after it shows.
  $effect(() => {
    if (!updated) return;
    const id = updated.id;
    const t = setTimeout(() => {
      if (updated?.id === id) updated = null;
    }, 4000);
    return () => clearTimeout(t);
  });

  // --- Git sync-loop divergence notices (git-sync spec §10.4) ----------------
  // (6) Sync notices: DISMISSIBLE, never auto-dismissed — unlike "Updated on
  // disk" (a transient fact) each carries a filename to remember. Queued rather
  // than latest-wins so a second notice cannot swallow the first's path.
  let syncNotices = $state<PendingSyncNotice[]>([]);
  let syncSeq = 0;

  function showSyncNotice(notice: SyncNotice): void {
    syncNotices = [...syncNotices, { id: ++syncSeq, notice }];
  }
  function dismissSyncNotice(id: number): void {
    syncNotices = syncNotices.filter((n) => n.id !== id);
  }

  // Route a genuine (non-echo — the http seam already drops our own) SSE change.
  function handleChange(change: FileChange): void {
    // Read-only surfaces always refresh (tree / backlinks / tags / link index) —
    // this replaces App's own (web-gated-off) subscription.
    void bundle.load();
    void indexStore.refresh();

    const action = routeFileChange(change, editor.path, editor.dirty);
    switch (action.type) {
      case 'refresh':
        break;
      case 'reload':
        // Clean buffer: silent reload from disk + a non-blocking notice.
        void editor.reloadActiveExternal();
        showUpdatedNotice(action.author);
        break;
      case 'conflict':
        raiseConflict(action.author);
        break;
      case 'deleted':
        if (!action.dirty) {
          // Clean buffer, nothing to reload to → drop the buffer to empty state.
          if (editor.path !== null) void editor.onExternalChange('removed', [editor.path]);
        } else {
          // Dirty buffer becomes an orphan the user can re-create via Save.
          deleted = { author: action.author };
        }
        break;
    }
  }

  // --- Conflict dialog actions (ticket 08 §3) --------------------------------
  async function conflictDiscard(): Promise<void> {
    await editor.discardActiveEdits();
    conflict = null;
  }
  function conflictKeep(): void {
    // Dismiss; buffer stays dirty. The next Save overwrites their version
    // (last-write-wins); a further external change re-raises this dialog.
    conflict = null;
  }

  // --- Deleted state actions (ticket 08 §2) ----------------------------------
  async function deletedRecreate(): Promise<void> {
    // Save on a deleted path re-creates it (`create … via web`); buffer clean.
    await editor.flush();
    deleted = null;
  }
  function deletedDiscard(): void {
    const p = editor.path;
    deleted = null;
    // Abandon the orphaned buffer without writing (drops it from the registry).
    if (p !== null) void editor.onExternalChange('removed', [p]);
  }

  // --- Three-way leave modal (ticket 08 §4) — resolves the workspace gate ------
  async function leaveSave(): Promise<void> {
    const s = leave;
    await s?.doc.flush();
    leave = null;
    s?.resolve(true);
  }
  async function leaveDiscard(): Promise<void> {
    const s = leave;
    await s?.doc.discardLocalEdits();
    leave = null;
    s?.resolve(true);
  }
  function leaveCancel(): void {
    const s = leave;
    leave = null;
    s?.resolve(false);
  }

  // --- Three-way structural-op modal (ticket 08 §5) — resolves treeActions gate -
  async function structuralSave(): Promise<void> {
    const s = structural;
    await s?.doc.flush();
    structural = null;
    s?.resolve(true);
  }
  async function structuralDiscard(): Promise<void> {
    const s = structural;
    await s?.doc.discardLocalEdits();
    structural = null;
    s?.resolve(true);
  }
  function structuralCancel(): void {
    const s = structural;
    structural = null;
    s?.resolve(false);
  }

  // --- Explicit Save (ticket 08 §4) ------------------------------------------
  function save(): void {
    if (editor.dirty) void editor.flush();
  }

  onMount(() => {
    let disposed = false;
    void (async () => {
      const mod = await import('$lib/App.svelte');
      if (disposed) return;
      AppComponent = mod.default as unknown as Component;
    })();

    // Everything below is web-only. The island is only ever mounted on the web
    // build, but guard anyway so an accidental desktop import dead-code-strips it.
    if (!__SUNSTONE_WEB__) {
      return () => {
        disposed = true;
      };
    }

    // (1) SSE routing — the SINGLE file-change handler on web.
    const unsubscribe = backend.onFileChanged(handleChange);

    // (6) Sync notices ride the SAME `/api/events` connection (a named `sync`
    //     event); only a git-synced server ever emits one.
    const unsubscribeSync = backend.onSyncNotice(showSyncNotice);

    // (3) Dirty-leave gate: a Concept switch / Tile close over a dirty buffer
    //     routes through the three-way leave modal, whose choice resolves here.
    setDirtyLeaveGate(
      (doc) =>
        new Promise<boolean>((resolve) => {
          leave = { doc, resolve };
        }),
    );

    // (4) Structural-op gate: rename/move/delete over a dirty buffer routes
    //     through the three-way structural modal (create is exempt).
    treeActions.beforeStructuralOp = (op, target) =>
      new Promise<boolean>((resolve) => {
        const doc = editor.workspace.activeTile.activeDocument;
        if (!doc || !structuralOpGated(op, doc.dirty)) {
          resolve(true);
          return;
        }
        structural = { op, target, doc, resolve };
      });

    // (2) Cmd/Ctrl+S → flush the active Document (one commit).
    const onKeydown = (e: KeyboardEvent) => {
      if (matchesHotkey(e, { key: 's' })) {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKeydown, true);

    // (5) Tab close / reload guard — armed only while the buffer is dirty.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (editor.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeSync();
      setDirtyLeaveGate(null);
      treeActions.beforeStructuralOp = null;
      window.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (conflictBurst) clearTimeout(conflictBurst);
    };
  });
</script>

{#snippet account()}
  <!-- The rail's bottom user slot: an avatar that opens a menu with the display
       name + Sign out (replaces the old top-right account bar). -->
  {#if user}
    <UserMenu {user} onSignOut={signOut} />
  {/if}
{/snippet}

{#if AppComponent}
  <div class="web-app-shell" data-testid="web-app-shell">
    <AppComponent initialConcept={selected} {account} />

    <!-- Explicit Save (ticket 08 §4) lives in the per-Tile header now (between
         undo/redo and the Edit toggle), shown only while editing + dirty; its
         presence IS the dirty indicator. Cmd/Ctrl+S (wired in onMount) remains
         the keyboard path. -->

    <WebConcurrencyModals
      {conceptName}
      {updated}
      {syncNotices}
      {deleted}
      {conflict}
      {leave}
      {structural}
      onDismissSyncNotice={dismissSyncNotice}
      onConflictDiscard={conflictDiscard}
      onConflictKeep={conflictKeep}
      onDeletedRecreate={deletedRecreate}
      onDeletedDiscard={deletedDiscard}
      onLeaveSave={leaveSave}
      onLeaveDiscard={leaveDiscard}
      onLeaveCancel={leaveCancel}
      onStructuralSave={structuralSave}
      onStructuralDiscard={structuralDiscard}
      onStructuralCancel={structuralCancel}
    />
  </div>
{:else}
  <p class="loading" data-testid="web-app-loading">Loading workspace…</p>
{/if}

<style>
  .web-app-shell {
    height: 100vh;
    min-height: 0;
    min-width: 0;
    /* Thin, token-coloured scrollbars (Firefox/standard), matching the anon
       read surface's `.app`. The desktop App shell sets none — it relies on
       WebKitGTK's native overlay scrollbars — but mounted in a browser here it
       would otherwise show the browser's default fat scrollbar. This wrapper is
       web-only (never rendered on desktop), so the desktop shell is untouched. */
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong, #8886) transparent;
  }

  /* WebKit/Blink scrollbar fallback — slim, rounded, token-coloured, subtle. */
  .web-app-shell :global(*::-webkit-scrollbar) {
    width: 8px;
    height: 8px;
  }
  .web-app-shell :global(*::-webkit-scrollbar-track) {
    background: transparent;
  }
  .web-app-shell :global(*::-webkit-scrollbar-thumb) {
    background: var(--border-strong, #8886);
    border-radius: 8px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }
  .web-app-shell :global(*::-webkit-scrollbar-thumb:hover) {
    background: var(--text-faint, #999);
    border: 2px solid transparent;
    background-clip: padding-box;
  }

  /* The SSR + pre-import state for a signed-in visitor: this IS the first paint
     (the anon read surface is not rendered for them), so it fills the viewport
     over the themed app background instead of reading as a stray line of text. */
  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    margin: 0;
    color: var(--text-muted, #777);
  }
</style>
