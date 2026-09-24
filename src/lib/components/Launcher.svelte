<script lang="ts">
  import { onMount } from 'svelte';
  import { backend } from '$lib/ipc';
  import { applyTheme, theme } from '$lib/state/theme.svelte';
  import { errMessage } from '$lib/errors';
  import type { KnownBundle } from '$lib/types';
  import { relativeTime } from '$lib/relativeTime';
  import { launcherRows } from '$lib/launcherRows';
  import { highlightPositions } from '$lib/highlight';
  import { clampIndex, listKeyIntent, stepIndex } from '$lib/listNav';

  // The launcher: shown when Sunstone starts with no Bundle (`sunstone` alone).
  // A palette over the previously-opened folders — an auto-focused filter box on
  // top, then one single-line row per folder path (most-recent first, each
  // removable), plus an "Open folder…" native picker. Typing fuzzy-filters the
  // list (matched chars highlighted), ↑/↓ step the selection and Enter opens it.
  // Opening a folder opens it in-process, then we reload so `DesktopShell`
  // re-decides and lands on the editor `<App/>`.

  let bundles = $state<KnownBundle[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);

  let query = $state('');
  let selected = $state(0);
  let filterInput = $state<HTMLInputElement | null>(null);
  let list = $state<HTMLUListElement | null>(null);

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

  // The visible rows (pure; see `launcherRows`). Empty query → the backend's
  // recency order; otherwise the fuzzy matches, best first.
  const rows = $derived(launcherRows(query, bundles));

  // The effective selection, clamped to the current rows without writing back to
  // state (avoids an effect-update loop), exactly like the quick-nav palette.
  const activeIndex = $derived(clampIndex(selected, rows.length));

  // Keep the highlighted row inside the scrollable list as ↑/↓ move (and wrap).
  $effect(() => {
    void activeIndex;
    void rows;
    list?.querySelector<HTMLElement>('.row.selected')?.scrollIntoView({ block: 'nearest' });
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
    // The X now holds focus (and may even be gone); hand it back to the filter so
    // ↑/↓/Enter keep driving the list.
    filterInput?.focus();
  }

  // Typing re-ranks the list, so the selection restarts at the best match.
  function onInput() {
    selected = 0;
  }

  function onKeydown(e: KeyboardEvent) {
    const intent = listKeyIntent(e);
    if (intent === 'next' || intent === 'prev') {
      e.preventDefault();
      selected = stepIndex(intent, activeIndex, rows.length);
    } else if (intent === 'enter') {
      e.preventDefault();
      const row = rows[activeIndex];
      if (row) void open(row.bundle.path);
    } else if (e.key === 'Escape' && query !== '') {
      // Escape clears the filter (there is nothing to close behind the launcher).
      e.preventDefault();
      query = '';
      selected = 0;
    }
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

    <!-- svelte-ignore a11y_autofocus -->
    <input
      bind:this={filterInput}
      bind:value={query}
      class="filter"
      type="text"
      placeholder="Filter folders…"
      aria-label="Filter folders"
      role="combobox"
      aria-expanded="true"
      aria-controls="launcher-list"
      aria-activedescendant={rows.length > 0 ? `launcher-row-${activeIndex}` : undefined}
      data-testid="launcher-filter"
      autocomplete="off"
      spellcheck="false"
      autofocus
      oninput={onInput}
      onkeydown={onKeydown}
    />

    {#if loading}
      <p class="status">Loading…</p>
    {:else if bundles.length === 0}
      <p class="status empty" data-testid="launcher-empty">
        No recent folders yet. Open one to get started.
      </p>
    {:else}
      <ul id="launcher-list" class="list" role="listbox" data-testid="launcher-list">
        {#each rows as row, i (row.bundle.path)}
          <li
            id={`launcher-row-${i}`}
            class="item"
            class:missing={!row.bundle.exists}
            role="option"
            aria-selected={i === activeIndex}
          >
            <button
              type="button"
              class="row"
              class:selected={i === activeIndex}
              data-testid="launcher-item"
              data-path={row.bundle.path}
              title={row.bundle.path}
              disabled={busy}
              onmousemove={() => (selected = i)}
              onclick={() => open(row.bundle.path)}
            >
              <span class="path"
                >{#each highlightPositions(row.bundle.path, row.positions) as seg}<span
                    class:hit={seg.match}>{seg.text}</span
                  >{/each}</span
              >
              {#if !row.bundle.exists}
                <span class="badge" title="Folder not found on disk">missing</span>
              {/if}
              {#if relativeTime(row.bundle.lastOpened)}
                <span class="when">{relativeTime(row.bundle.lastOpened)}</span>
              {/if}
            </button>
            <button
              type="button"
              class="forget"
              data-testid="launcher-forget"
              data-path={row.bundle.path}
              title="Forget this folder"
              aria-label={`Forget ${row.bundle.name}`}
              onclick={(e) => forget(row.bundle.path, e)}
            >×</button>
          </li>
        {:else}
          <li class="status" data-testid="launcher-no-matches">No folders match</li>
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
    width: min(620px, 92vw);
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
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

  .filter {
    box-sizing: border-box;
    width: 100%;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 0.95rem;
  }

  .filter:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .status {
    margin: 0;
    padding: 1rem 0;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.9rem;
    list-style: none;
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
    gap: 0.1rem;
    overflow-y: auto;
  }

  .item {
    display: flex;
    align-items: stretch;
    gap: 0.15rem;
    border-radius: var(--radius-md);
  }

  /* One folder = one line: the path stretches, the badges/timestamp stay put. */
  .row {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.3rem 0.55rem;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease;
  }

  .row.selected {
    background: var(--hover);
    border-color: var(--border-strong);
  }

  .row:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .path {
    flex: 1 1 auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 0.9rem;
  }

  /* Fuzzy-match hits inside the path. */
  .path .hit {
    color: var(--accent);
    font-weight: 700;
  }

  .when {
    flex: none;
    color: var(--text-faint);
    font-size: 0.78rem;
    white-space: nowrap;
  }

  .badge {
    flex: none;
    padding: 0.05rem 0.35rem;
    border-radius: var(--radius-pill);
    background: color-mix(in srgb, var(--danger) 18%, transparent);
    color: var(--danger);
    font-size: 0.68rem;
    font-weight: 600;
  }

  .item.missing .path {
    color: var(--text-muted);
  }

  .forget {
    flex: none;
    width: 1.8rem;
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
