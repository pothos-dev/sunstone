<script lang="ts">
  import { onMount } from 'svelte';
  import { backend } from '$lib/ipc';
  import { applyTheme, theme } from '$lib/state/theme.svelte';
  import { errMessage } from '$lib/errors';
  import type { KnownBundle } from '$lib/types';

  // The launcher: shown when Sunstone starts with no Bundle (`sunstone` alone).
  // Lists previously-opened folders (most-recent first, each removable) and an
  // "Open folder…" native picker. Picking a folder opens it in-process, then we
  // reload so `DesktopShell` re-decides and lands on the editor `<App/>`.

  let bundles = $state<KnownBundle[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);

  let launcherRoot = $state<HTMLDivElement | null>(null);

  onMount(() => {
    const stopTheme = theme.start();
    void refresh();
    return stopTheme;
  });

  // Apply the resolved theme as `data-theme` so the shared design tokens (and the
  // `body:has([data-theme=dark])` rule) resolve correctly in either scheme.
  $effect(() => {
    applyTheme(launcherRoot, theme.resolved);
  });

  async function refresh() {
    loading = true;
    try {
      bundles = await backend.listKnownBundles();
    } catch (e) {
      error = errMessage(e);
    } finally {
      loading = false;
    }
  }

  // Open a folder and reload into the editor. `busy` guards against a second
  // click during the brief window before the reload takes over.
  async function open(path: string) {
    if (busy) return;
    error = null;
    busy = true;
    try {
      await backend.openBundle(path);
      location.reload();
    } catch (e) {
      error = errMessage(e);
      busy = false;
    }
  }

  async function openNew() {
    if (busy) return;
    try {
      const picked = await backend.pickFolder();
      if (picked !== null) await open(picked);
    } catch (e) {
      error = errMessage(e);
    }
  }

  async function forget(path: string, ev: MouseEvent) {
    // The X sits inside the row; don't let its click also open the folder.
    ev.stopPropagation();
    try {
      await backend.forgetBundle(path);
      bundles = bundles.filter((b) => b.path !== path);
    } catch (e) {
      error = errMessage(e);
    }
  }

  /** Compact "time since last opened" label, or '' when never stamped. */
  function relativeTime(ms: number | null): string {
    if (ms === null) return '';
    const diff = Date.now() - ms;
    if (diff < 0) return 'just now';
    const min = 60_000;
    const hour = 60 * min;
    const day = 24 * hour;
    const week = 7 * day;
    if (diff < min) return 'just now';
    if (diff < hour) return `${Math.floor(diff / min)}m ago`;
    if (diff < day) return `${Math.floor(diff / hour)}h ago`;
    if (diff < week) return `${Math.floor(diff / day)}d ago`;
    if (diff < 5 * week) return `${Math.floor(diff / week)}w ago`;
    return new Date(ms).toLocaleDateString();
  }
</script>

<div class="launcher" data-testid="launcher" bind:this={launcherRoot}>
  <div class="card">
    <header class="head">
      <h1 class="title">Sunstone</h1>
      <p class="subtitle">Open a folder to start</p>
    </header>

    {#if error}
      <p class="error" role="alert" data-testid="launcher-error">{error}</p>
    {/if}

    {#if loading}
      <p class="status">Loading…</p>
    {:else if bundles.length === 0}
      <p class="status empty" data-testid="launcher-empty">
        No recent folders yet. Open one to get started.
      </p>
    {:else}
      <ul class="list" data-testid="launcher-list">
        {#each bundles as b (b.path)}
          <li class="item" class:missing={!b.exists}>
            <button
              type="button"
              class="row"
              data-testid="launcher-item"
              data-path={b.path}
              title={b.path}
              disabled={busy}
              onclick={() => open(b.path)}
            >
              <span class="name">
                {b.name}
                {#if !b.exists}<span class="badge" title="Folder not found on disk">missing</span>{/if}
              </span>
              <span class="path">{b.path}</span>
              {#if relativeTime(b.lastOpened)}
                <span class="when">{relativeTime(b.lastOpened)}</span>
              {/if}
            </button>
            <button
              type="button"
              class="forget"
              data-testid="launcher-forget"
              data-path={b.path}
              title="Forget this folder"
              aria-label={`Forget ${b.name}`}
              onclick={(e) => forget(b.path, e)}
            >×</button>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="actions">
      <button
        type="button"
        class="open-new"
        data-testid="launcher-open-folder"
        disabled={busy}
        onclick={openNew}
      >Open folder…</button>
    </div>
  </div>
</div>

<style>
  .launcher {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    overflow: auto;
    /* The first screen a user sees — carry the warm sunstone gradient here so
       the branded launcher reads as a sunlit canvas behind the elevated card. */
    background: var(--bg-gradient, var(--bg));
    color: var(--text);
  }

  .card {
    width: min(520px, 92vw);
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.75rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
  }

  .head {
    text-align: center;
  }

  .title {
    margin: 0;
    font-size: 1.6rem;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .subtitle {
    margin: 0.25rem 0 0;
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  .status {
    margin: 0;
    padding: 1rem 0;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  .error {
    margin: 0;
    padding: 0.55rem 0.75rem;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--danger) 16%, transparent);
    color: var(--danger);
    font-size: 0.85rem;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    overflow-y: auto;
  }

  .item {
    display: flex;
    align-items: stretch;
    gap: 0.25rem;
    border-radius: var(--radius-md);
  }

  .row {
    flex: 1 1 auto;
    min-width: 0;
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-areas:
      'name when'
      'path path';
    gap: 0.1rem 0.5rem;
    align-items: baseline;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease;
  }

  .row:hover:not(:disabled) {
    background: var(--hover);
    border-color: var(--border-strong);
  }

  .row:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .name {
    grid-area: name;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .when {
    grid-area: when;
    color: var(--text-faint);
    font-size: 0.78rem;
    white-space: nowrap;
  }

  .path {
    grid-area: path;
    color: var(--text-muted);
    font-size: 0.78rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl; /* keep the tail (the folder itself) visible when truncated */
    text-align: left;
  }

  .badge {
    margin-left: 0.4rem;
    padding: 0.05rem 0.35rem;
    border-radius: var(--radius-pill);
    background: color-mix(in srgb, var(--danger) 18%, transparent);
    color: var(--danger);
    font-size: 0.68rem;
    font-weight: 600;
    vertical-align: middle;
  }

  .item.missing .name {
    color: var(--text-muted);
  }

  .forget {
    flex: none;
    width: 2rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: none;
    color: var(--text-faint);
    font-size: 1.15rem;
    line-height: 1;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }

  .forget:hover {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    color: var(--danger);
  }

  .actions {
    display: flex;
    justify-content: center;
    padding-top: 0.25rem;
  }

  .open-new {
    padding: 0.5rem 1.1rem;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--accent-contrast);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    transition: filter 0.12s ease;
  }

  .open-new:hover:not(:disabled) {
    filter: brightness(1.06);
  }

  .open-new:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
