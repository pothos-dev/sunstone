<script lang="ts">
  // PROTOTYPE — throwaway (ticket ui-1). A left-rail Bundle switcher: the rail
  // icon opens a dropdown of the known folders. Three structurally different
  // dropdowns, picked by `?variant=` (A/B/C) and cycled with the floating bar:
  //   A — Menu:    compact popover, no filter, current on top with a check.
  //   B — Palette: the startup launcher as a popover — auto-focused fuzzy
  //                filter, ↑/↓/Enter, forget ×, "Open folder…" footer.
  //   C — Panel:   full-height flyout over the sidebar — a big "current" card,
  //                then Recent / Missing groups with relative times.
  // Switching saves pending writes first (`beforeSwitch`), then opens the folder
  // in-process and reloads, exactly like the startup launcher.
  import { backend } from '$lib/ipc';
  import { bundle } from '$lib/state/bundle.svelte';
  import { useOverlay } from '$lib/state/overlay.svelte';
  import { launcherRows } from '$lib/launcherRows';
  import { highlightPositions } from '$lib/highlight';
  import { relativeTime } from '$lib/relativeTime';
  import { clampIndex, listKeyIntent, stepIndex } from '$lib/listNav';
  import { explorerTitle } from '$lib/treeNav';
  import type { KnownBundle } from '$lib/types';
  import PrototypeSwitcher from '$lib/components/PrototypeSwitcher.svelte';

  interface Props {
    /** Land pending writes before the reload a switch triggers. */
    beforeSwitch: () => Promise<unknown>;
  }

  let { beforeSwitch }: Props = $props();

  const VARIANTS = [
    { key: 'A', name: 'Menu' },
    { key: 'B', name: 'Palette' },
    { key: 'C', name: 'Panel' },
  ];
  let variant = $state(new URLSearchParams(location.search).get('variant') ?? 'A');

  let open = $state(false);
  let known = $state<KnownBundle[]>([]);
  let currentPath = $state<string | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let query = $state('');
  let selected = $state(0);
  let button = $state<HTMLButtonElement | null>(null);
  let popover = $state<HTMLDivElement | null>(null);
  let filter = $state<HTMLInputElement | null>(null);
  let top = $state(0);

  useOverlay(
    () => open,
    () => (open = false),
  );

  // The current Bundle always heads the list, even when the store has no entry
  // for it yet; its title comes from the live tree (root index.md).
  const current = $derived<KnownBundle | null>(
    currentPath === null
      ? null
      : {
          ...(known.find((b) => b.path === currentPath) ?? {
            path: currentPath,
            name: currentPath.split('/').filter(Boolean).pop() ?? currentPath,
            lastOpened: null,
            exists: true,
          }),
          title: explorerTitle(bundle.tree) === 'Explorer' ? null : explorerTitle(bundle.tree),
        },
  );
  const others = $derived(known.filter((b) => b.path !== currentPath));
  const all = $derived(current ? [current, ...others] : others);
  const rows = $derived(launcherRows(query, all));
  const activeIndex = $derived(clampIndex(selected, rows.length));

  async function toggle() {
    if (open) {
      open = false;
      return;
    }
    top = button?.getBoundingClientRect().top ?? 0;
    query = '';
    selected = 0;
    error = null;
    open = true;
    [known, currentPath] = await Promise.all([backend.listKnownBundles(), backend.bundleRoot()]);
    if (variant === 'B') queueMicrotask(() => filter?.focus());
  }

  async function choose(path: string) {
    if (busy) return;
    if (path === currentPath) {
      open = false;
      return;
    }
    busy = true;
    try {
      await beforeSwitch();
      await backend.openBundle(path);
      location.reload();
    } catch (e) {
      error = String(e);
      busy = false;
    }
  }

  async function forget(path: string, ev: MouseEvent) {
    ev.stopPropagation();
    await backend.forgetBundle(path);
    known = known.filter((b) => b.path !== path);
  }

  async function openNew() {
    const picked = await backend.pickFolder();
    if (picked !== null) await choose(picked);
  }

  function onKeydown(e: KeyboardEvent) {
    const intent = listKeyIntent(e);
    if (intent === 'next' || intent === 'prev') {
      e.preventDefault();
      selected = stepIndex(intent, activeIndex, rows.length);
    } else if (intent === 'enter') {
      e.preventDefault();
      const row = rows[activeIndex];
      if (row) void choose(row.bundle.path);
    }
  }

  // Click outside closes.
  $effect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popover?.contains(t) && !button?.contains(t)) open = false;
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  });

  const label = (b: KnownBundle) => b.title || b.name;
</script>

<button
  bind:this={button}
  type="button"
  class="rail-btn"
  class:active={open}
  data-testid="rail-bundle-switcher"
  title="Switch Bundle"
  aria-label="Switch Bundle"
  aria-expanded={open}
  onclick={toggle}
>
  <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
    <!-- stacked folders glyph -->
    <path
      d="M2 5.5V12a1 1 0 0 0 1 1h9.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
      stroke-linecap="round"
    />
    <path
      d="M4 3.5h2.6l1.2 1.3H13a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linejoin="round"
    />
  </svg>
</button>

{#if open}
  {#if variant === 'A'}
    <!-- A — Menu -->
    <div class="pop menu" bind:this={popover} style="top: {top}px" data-testid="bundle-switcher">
      {#each all as b (b.path)}
        <button
          type="button"
          class="menu-item"
          class:current={b.path === currentPath}
          class:missing={!b.exists}
          title={b.path}
          disabled={!b.exists}
          onclick={() => choose(b.path)}
        >
          <span class="check">{b.path === currentPath ? '✓' : ''}</span>
          <span class="name">{label(b)}</span>
        </button>
        {#if b.path === currentPath && others.length > 0}<hr />{/if}
      {/each}
      <hr />
      <button type="button" class="menu-item" onclick={openNew}>
        <span class="check"></span><span class="name">Open folder…</span>
      </button>
    </div>
  {:else if variant === 'B'}
    <!-- B — Palette -->
    <div
      class="pop palette"
      bind:this={popover}
      style="top: {top}px"
      data-testid="bundle-switcher"
    >
      <input
        bind:this={filter}
        bind:value={query}
        class="filter"
        placeholder="Switch to folder…"
        oninput={() => (selected = 0)}
        onkeydown={onKeydown}
      />
      <ul class="rows">
        {#each rows as row, i (row.bundle.path)}
          <li class="item" class:missing={!row.bundle.exists}>
            <button
              type="button"
              class="row"
              class:selected={i === activeIndex}
              title={row.bundle.path}
              onmousemove={() => (selected = i)}
              onclick={() => choose(row.bundle.path)}
            >
              <span class="label">
                {#if row.bundle.title}
                  <span class="title"
                    >{#each highlightPositions(row.bundle.title, row.titlePositions) as s}<span
                        class:hit={s.match}>{s.text}</span
                      >{/each}</span
                  >
                {/if}
                <span class="path" class:sub={!!row.bundle.title}
                  >{#each highlightPositions(row.bundle.path, row.positions) as s}<span
                      class:hit={s.match}>{s.text}</span
                    >{/each}</span
                >
              </span>
              {#if row.bundle.path === currentPath}
                <span class="pill">current</span>
              {:else if !row.bundle.exists}
                <span class="pill danger">missing</span>
              {/if}
            </button>
            {#if row.bundle.path !== currentPath}
              <button
                type="button"
                class="forget"
                title="Forget this folder"
                onclick={(e) => forget(row.bundle.path, e)}>×</button
              >
            {/if}
          </li>
        {:else}
          <li class="empty">No folders match</li>
        {/each}
      </ul>
      <button type="button" class="footer" onclick={openNew}>Open folder…</button>
    </div>
  {:else}
    <!-- C — Panel -->
    <div class="panel" bind:this={popover} data-testid="bundle-switcher">
      {#if current}
        <section class="current-card">
          <div class="eyebrow">Current Bundle</div>
          <div class="big">{label(current)}</div>
          <div class="path sub">{current.path}</div>
        </section>
      {/if}
      <div class="group">Recent</div>
      {#each others.filter((b) => b.exists) as b (b.path)}
        <div class="p-item">
          <button type="button" class="p-row" title={b.path} onclick={() => choose(b.path)}>
            <span class="label">
              <span class="title">{label(b)}</span>
              <span class="path sub">{b.path}</span>
            </span>
            <span class="when">{relativeTime(b.lastOpened)}</span>
          </button>
          <button
            type="button"
            class="forget"
            title="Forget this folder"
            onclick={(e) => forget(b.path, e)}>×</button
          >
        </div>
      {:else}
        <div class="empty">No other folders yet</div>
      {/each}
      {#if others.some((b) => !b.exists)}
        <div class="group">Missing</div>
        {#each others.filter((b) => !b.exists) as b (b.path)}
          <div class="p-item missing">
            <span class="p-row static">
              <span class="label">
                <span class="title">{label(b)}</span>
                <span class="path sub">{b.path}</span>
              </span>
            </span>
            <button
              type="button"
              class="forget"
              title="Forget this folder"
              onclick={(e) => forget(b.path, e)}>×</button
            >
          </div>
        {/each}
      {/if}
      <div class="spacer"></div>
      <button type="button" class="open-btn" onclick={openNew}>Open folder…</button>
    </div>
  {/if}
  {#if error}<div class="pop-error" style="top: {top}px">{error}</div>{/if}
{/if}

<PrototypeSwitcher variants={VARIANTS} current={variant} onchange={(k) => (variant = k)} />

<style>
  .rail-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    opacity: 0.85;
  }

  .rail-btn:hover,
  .rail-btn.active {
    background: var(--hover);
    opacity: 1;
  }

  .pop {
    position: fixed;
    left: 52px;
    z-index: 500;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
    font-family: var(--font-ui);
  }

  /* A — Menu */
  .menu {
    min-width: 14rem;
    max-width: 22rem;
    padding: 0.3rem;
  }

  .menu hr {
    margin: 0.25rem 0.2rem;
    border: none;
    border-top: 1px solid var(--border);
  }

  .menu-item {
    display: flex;
    align-items: center;
    width: 100%;
    gap: 0.4rem;
    padding: 0.35rem 0.5rem;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.88rem;
    text-align: left;
    cursor: pointer;
  }

  .menu-item:hover:not(:disabled) {
    background: var(--hover);
  }

  .menu-item.current {
    font-weight: 600;
  }

  .menu-item.missing {
    color: var(--text-faint);
    text-decoration: line-through;
  }

  .check {
    width: 1rem;
    color: var(--accent);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* B — Palette */
  .palette {
    width: 28rem;
    padding: 0.5rem;
  }

  .filter {
    box-sizing: border-box;
    width: 100%;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: inherit;
    font: inherit;
  }

  .rows {
    list-style: none;
    margin: 0.4rem 0;
    padding: 0;
    max-height: 18rem;
    overflow: auto;
  }

  .item {
    display: flex;
  }

  .row {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.5rem;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row.selected {
    background: var(--hover);
    border-color: var(--border-strong);
  }

  .label {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .title,
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.9rem;
  }

  .path.sub {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .hit {
    color: var(--accent);
    font-weight: 700;
  }

  .pill {
    flex: none;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-pill);
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 0.68rem;
    font-weight: 600;
  }

  .pill.danger {
    background: color-mix(in srgb, var(--danger) 18%, transparent);
    color: var(--danger);
  }

  .item.missing .title,
  .item.missing .path {
    color: var(--text-faint);
  }

  .forget {
    flex: none;
    width: 1.8rem;
    border: none;
    border-radius: var(--radius-md);
    background: none;
    color: var(--text-faint);
    cursor: pointer;
  }

  .forget:hover {
    background: var(--hover);
    color: var(--text);
  }

  .footer {
    width: 100%;
    padding: 0.4rem;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-md);
    background: none;
    color: var(--text-muted);
    font: inherit;
    cursor: pointer;
  }

  .footer:hover {
    background: var(--hover);
  }

  .empty {
    padding: 0.6rem;
    color: var(--text-faint);
    font-size: 0.85rem;
  }

  /* C — Panel */
  .panel {
    position: fixed;
    top: 0;
    left: 48px;
    bottom: 0;
    z-index: 500;
    box-sizing: border-box;
    width: 20rem;
    display: flex;
    flex-direction: column;
    padding: 1rem 0.75rem;
    border-right: 1px solid var(--border-strong);
    background: var(--bg-elevated);
    box-shadow: 8px 0 30px rgba(0, 0, 0, 0.15);
    font-family: var(--font-ui);
  }

  .current-card {
    padding: 0.8rem;
    border-radius: var(--radius-md);
    background: var(--accent-soft);
  }

  .eyebrow,
  .group {
    color: var(--text-muted);
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .big {
    margin: 0.2rem 0;
    font-size: 1.15rem;
    font-weight: 700;
  }

  .group {
    margin: 1.1rem 0.3rem 0.4rem;
  }

  .p-item {
    display: flex;
  }

  .p-row {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem;
    border: none;
    border-radius: var(--radius-md);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .p-row:not(.static):hover {
    background: var(--hover);
  }

  .p-item.missing .title {
    color: var(--text-faint);
  }

  .when {
    flex: none;
    color: var(--text-faint);
    font-size: 0.75rem;
  }

  .spacer {
    flex: 1;
  }

  .open-btn {
    padding: 0.5rem;
    border: none;
    border-radius: var(--radius-md);
    background: var(--accent);
    color: var(--accent-contrast);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .pop-error {
    position: fixed;
    left: 52px;
    z-index: 600;
    color: var(--danger);
  }
</style>
