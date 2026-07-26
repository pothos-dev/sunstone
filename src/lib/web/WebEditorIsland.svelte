<script module lang="ts">
  import type { GatedStructuralOp } from './concurrency';

  /**
   * The imperative surface the island hands back to `WebViewer` (via the
   * `onReady` prop) so the viewer's Edit toggle + tree navigation can drive the
   * buffer without reaching into the island's internals:
   *   - `requestDone` — the Edit-toggle click: Save if dirty, then exit to the
   *     rendered view (ticket 08 §4 — the toggle IS the save path, no dialog);
   *   - `tryLeave` — an implicit exit (switch Concept / toggle Edit off): resolve
   *     a dirty buffer through the three-way leave modal, then `proceed`;
   *   - `requestStructuralOp` — a rename/move/delete from the tree: gate on a
   *     clean active buffer (create is exempt), else the three-way structural
   *     modal, then `proceed`. Exposed for the tree-CRUD wiring that lands with
   *     the web tree write surface.
   */
  export interface WebEditorApi {
    requestDone(): void;
    tryLeave(proceed: () => void): void;
    requestStructuralOp(
      op: GatedStructuralOp | 'create',
      target: string,
      proceed: () => void | Promise<void>,
    ): void;
  }
</script>

<script lang="ts">
  // Client-only web editor island (tickets 06 + 08). WebViewer stays the SSR
  // read surface and reaches this component ONLY via a dynamic `import()` behind
  // an `onMount`/`browser` guard, so the desktop `Tile` (and, transitively,
  // CodeMirror / the atomic editor) never enters the SSR graph. This island then
  // dynamic-`import()`s `Tile.svelte` itself and constructs a single-Tile
  // `Workspace` for the open Concept against the `http` backend (seam already
  // wired). Desktop-only affordances (Region focus grid, tile split, layout
  // persistence, tree CRUD) are stubbed to minimal single-Tile state — the
  // focus/region system is NOT ported.
  //
  // The concurrency UX (ticket 08 §2-5) lives here as a THIN switch over the
  // pure `concurrency.ts` helpers: SSE change routing (refresh/reload/conflict/
  // deleted), the three-way leave modal, the beforeunload guard, and the
  // structural-op gate.
  import { onMount, tick } from 'svelte';
  import type { Component } from 'svelte';
  import { backend } from '$lib/ipc';
  import { indexStore } from '$lib/state/index.svelte';
  import type { Tile, Workspace } from '$lib/state/workspace.svelte';
  import type { FileChange, SyncNotice } from '$lib/types';
  import { routeFileChange, structuralOpGated } from './concurrency';
  import WebConcurrencyModals from './WebConcurrencyModals.svelte';
  import type { PendingSyncNotice } from './WebConcurrencyModals.svelte';

  interface Props {
    /** bundle-relative path of the Concept to edit (mount-time; forward-slash). */
    path: string;
    /** Leave edit mode → back to the SSR rendered view (WebViewer re-fetches). */
    onExit: () => void;
    /** Report the active buffer's dirtiness up (drives the Edit-toggle label). */
    onDirty: (dirty: boolean) => void;
    /** Hand the imperative API (above) to WebViewer once the island is live. */
    onReady: (api: WebEditorApi) => void;
  }

  let { path, onExit, onDirty, onReady }: Props = $props();

  // The lazily-loaded desktop editor component + its single-Tile state. Both are
  // resolved in `onMount` (client only) so nothing here is import-time heavy.
  let TileComponent = $state<Component | null>(null);
  let workspace = $state<Workspace | null>(null);
  let tile = $state<Tile | null>(null);

  // Short-name for the open Concept (basename, no `.md`) used in modal copy.
  const conceptName = $derived(basename(tile?.activePath ?? path));
  const dirty = $derived(tile?.dirty ?? false);

  // Mirror dirtiness up to WebViewer so the Edit toggle reads Save/Done.
  $effect(() => {
    onDirty(dirty);
  });

  function basename(p: string): string {
    const last = p.split('/').pop() ?? p;
    return last.replace(/\.md$/, '');
  }

  // --- Concurrency surfaces (all thin over concurrency.ts) --------------------
  let conflict = $state<{ author: string | null } | null>(null);
  let leave = $state<{ proceed: () => void } | null>(null);
  let structural = $state<{
    op: GatedStructuralOp;
    target: string;
    proceed: () => void | Promise<void>;
  } | null>(null);
  let deleted = $state<{ author: string | null } | null>(null);
  let updated = $state<{ author: string | null; id: number } | null>(null);
  let updatedSeq = 0;

  // Debounce a burst of external changes into a single (re-)raise of the
  // blocking conflict dialog (ticket 08 §3). "Keep my changes" clears it; a
  // further genuine change re-raises.
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
  // NO timeout, deliberately: unlike "Updated on disk" (a transient fact), these
  // carry a filename to remember, so each stays until it is dismissed. Queued
  // rather than latest-wins so a second notice cannot swallow the first's path.
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
    const active = tile?.activePath ?? null;
    const action = routeFileChange(change, active, tile?.dirty ?? false);
    switch (action.type) {
      case 'refresh':
        // Only other files changed: WebViewer's own subscription refreshes the
        // read-only chrome; here we just keep the editor's link index fresh.
        void indexStore.refresh();
        break;
      case 'reload':
        // Clean buffer: silent reload from disk + a non-blocking notice.
        void tile?.activeDocument?.reloadExternal();
        showUpdatedNotice(action.author);
        void indexStore.refresh();
        break;
      case 'conflict':
        raiseConflict(action.author);
        break;
      case 'deleted':
        if (!action.dirty) {
          // Clean buffer, nothing to reload to → drop back to the viewer.
          onExit();
        } else {
          // Dirty buffer becomes an orphan the user can re-create via Save.
          deleted = { author: action.author };
        }
        break;
    }
  }

  // --- Conflict dialog actions (ticket 08 §3) --------------------------------
  async function conflictDiscard(): Promise<void> {
    await tile?.activeDocument?.discardLocalEdits();
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
    await tile?.flush();
    deleted = null;
  }
  function deletedDiscard(): void {
    deleted = null;
    onExit();
  }

  // --- Three-way leave modal (ticket 08 §4) ----------------------------------
  async function leaveSave(): Promise<void> {
    const proceed = leave?.proceed;
    await tile?.flush();
    leave = null;
    proceed?.();
  }
  function leaveDiscard(): void {
    const proceed = leave?.proceed;
    leave = null;
    // The island unmounts on exit, discarding the in-memory buffer — no write.
    proceed?.();
  }
  function leaveCancel(): void {
    leave = null;
  }

  // --- Three-way structural-op modal (ticket 08 §5) --------------------------
  async function structuralSave(): Promise<void> {
    const s = structural;
    await tile?.flush();
    structural = null;
    await s?.proceed();
  }
  async function structuralDiscard(): Promise<void> {
    const s = structural;
    await tile?.activeDocument?.discardLocalEdits();
    structural = null;
    await s?.proceed();
  }
  function structuralCancel(): void {
    structural = null;
  }

  // --- The imperative API handed to WebViewer --------------------------------
  const api: WebEditorApi = {
    requestDone() {
      // The toggle click IS the save path when dirty; either way, exit after.
      void (async () => {
        if (tile?.dirty) await tile.flush();
        onExit();
      })();
    },
    tryLeave(proceed) {
      if (!tile?.dirty) proceed();
      else leave = { proceed };
    },
    requestStructuralOp(op, target, proceed) {
      if (op === 'create' || !structuralOpGated(op, tile?.dirty ?? false)) {
        void proceed();
        return;
      }
      structural = { op, target, proceed };
    },
  };

  onMount(() => {
    let unsubscribe: (() => void) | null = null;
    let disposed = false;

    void (async () => {
      // Pull the desktop editor + workspace state in ONE dynamic step — this is
      // the SSR boundary: neither is ever statically imported into WebViewer.
      const [{ Workspace }, tileMod] = await Promise.all([
        import('$lib/state/workspace.svelte'),
        import('$lib/components/Tile.svelte'),
      ]);
      if (disposed) return;
      TileComponent = tileMod.default as unknown as Component;
      const ws = new Workspace();
      await ws.activeTile.open(path);
      if (disposed) return;
      workspace = ws;
      tile = ws.activeTile;
      // Seed the link index so broken-link + wikilink resolution work in-editor.
      void indexStore.refresh();
      await tick();
      onReady(api);
    })();

    // SSE routing for the active buffer (own echoes already dropped by the seam).
    unsubscribe = backend.onFileChanged(handleChange);

    // Sync notices ride the SAME connection (a named `sync` event); the desktop
    // seam is a no-op, so this only ever fires on a git-synced server.
    const unsubscribeSync = backend.onSyncNotice(showSyncNotice);

    // Tab close / reload guard — armed only while the buffer is dirty (§4).
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (tile?.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      disposed = true;
      unsubscribe?.();
      unsubscribeSync();
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (conflictBurst) clearTimeout(conflictBurst);
    };
  });

  // Stubs for the desktop-only Tile affordances not ported to the web island.
  const noop = () => {};
</script>

<div class="web-editor" data-testid="web-editor">
  {#if TileComponent && tile}
    <TileComponent
      {tile}
      active={true}
      multipleTiles={false}
      focusTypeForPath={null}
      onActivate={noop}
      onSplitRight={noop}
      onSplitDown={noop}
      onClose={onExit}
    />
  {:else}
    <p class="loading" data-testid="web-editor-loading">Loading editor…</p>
  {/if}
</div>

<!-- Concurrency surfaces (notice / deleted banner / three blocking modals) —
     shared presentational markup; this island keeps the state + action logic. -->
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

<style>
  .web-editor {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    min-width: 0;
  }

  .loading {
    padding: 1rem;
    color: var(--text-muted, #777);
  }
</style>
