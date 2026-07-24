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
  //   2. Explicit Save — a dirty indicator + Save affordance + Cmd/Ctrl+S that
  //      flush the active Document (one commit); web blur-flush is suppressed in
  //      Tile, so persistence is explicit-only.
  //   3. Dirty-leave gate — registered on the workspace so a Concept switch / Tile
  //      close over a dirty buffer routes through the three-way leave modal.
  //   4. Structural-op gate — registered on `treeActions` so a rename/move/delete
  //      over a dirty buffer routes through the three-way structural modal.
  //   5. `beforeunload` guard — armed only while the active buffer is dirty.
  import { onMount } from 'svelte';
  import type { Component } from 'svelte';
  import { backend } from '$lib/ipc';
  import { bundle } from '$lib/state/bundle.svelte';
  import { editor } from '$lib/state/editor.svelte';
  import { indexStore } from '$lib/state/index.svelte';
  import { treeActions } from '$lib/state/treeActions.svelte';
  import { setDirtyLeaveGate } from '$lib/state/workspace.svelte';
  import type { Document } from '$lib/state/document.svelte';
  import type { FileChange } from '$lib/types';
  import { routeFileChange, structuralOpGated, type GatedStructuralOp } from './concurrency';
  import WebConcurrencyModals from './WebConcurrencyModals.svelte';
  import UserMenu from './UserMenu.svelte';
  import type { WebUser } from './loadConcept';

  interface Props {
    /** bundle-relative path of the SSR-selected Concept (forward-slash), or null. */
    selected: string | null;
    /** The authenticated user (for the rail's avatar / sign-out menu). */
    user: WebUser | null;
  }

  let { selected, user }: Props = $props();

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

  // --- Active-buffer state, read straight from the `editor` singleton ---------
  // `editor.path`/`editor.dirty` are reactive getters over the active Tile's
  // Document, so the indicator + Save affordance track the live buffer.
  const dirty = $derived(editor.dirty);

  function basename(p: string): string {
    const last = p.split('/').pop() ?? p;
    return last.replace(/\.md$/, '');
  }

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
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
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

    <!-- Explicit-Save affordance + dirty indicator (ticket 08 §4). -->
    <div class="save-bar">
      {#if dirty}
        <span class="dirty-dot" data-testid="web-dirty" title="Unsaved changes" aria-label="Unsaved changes"
        ></span>
      {/if}
      <button
        type="button"
        class="save-btn"
        data-testid="web-save"
        disabled={!dirty}
        onclick={save}>Save</button
      >
    </div>

    <WebConcurrencyModals
      {conceptName}
      {updated}
      {deleted}
      {conflict}
      {leave}
      {structural}
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

  .loading {
    padding: 1rem;
    color: var(--text-muted, #777);
  }

  /* Floating explicit-Save control, top-centre so it clears the sidebars. */
  .save-bar {
    position: fixed;
    top: 0.5rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }

  .dirty-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--accent, #d9622b);
  }

  .save-btn {
    padding: 0.25rem 0.7rem;
    border: 1px solid var(--border, #ccc);
    border-radius: var(--radius-sm, 6px);
    background: var(--bg-elevated, #f0f2f6);
    color: inherit;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    transition: background 0.12s ease;
  }

  .save-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .save-btn:not(:disabled):hover {
    background: var(--hover, rgba(127, 127, 127, 0.15));
  }
</style>
