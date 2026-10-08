<script lang="ts">
  /**
   * Bundle switcher (ticket ui-1): the startup launcher's known-folder list as a
   * popover over the open editor, anchored to the top of the left activity rail.
   * Opened by the rail button or Ctrl/Cmd+O (the parent owns both and toggles
   * `open`); desktop only.
   *
   * An auto-focused filter fuzzy-matches each folder's root index title and path
   * (`launcherRows`, shared with the launcher); ↑/↓ move, Enter switches. The
   * current Bundle is marked and choosing it just closes the popover. Switching
   * first writes every open Document (`beforeSwitch`); if one cannot be saved
   * the switch is refused and names it. Otherwise the folder opens in-process
   * and the webview reloads into it, exactly like the launcher.
   */
  import { backend } from '$lib/ipc';
  import { errMessage } from '$lib/errors';
  import { launcherRows } from '$lib/launcherRows';
  import { clampIndex, listKeyIntent, stepIndex } from '$lib/listNav';
  import { focus } from '$lib/state/focus.svelte';
  import { useOverlay } from '$lib/state/overlay.svelte';
  import type { KnownBundle } from '$lib/types';
  import KnownBundleLabel from '$lib/components/KnownBundleLabel.svelte';

  interface Props {
    /** Whether the popover is open. */
    open: boolean;
    /** Write every open Document; resolves to the paths that stay unsaved. */
    beforeSwitch: () => Promise<string[]>;
    /** Close the popover. */
    onclose: () => void;
  }

  let { open, beforeSwitch, onclose }: Props = $props();

  let known = $state<KnownBundle[]>([]);
  let current = $state<string | null>(null);
  let query = $state('');
  let selected = $state(0);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  let list = $state<HTMLUListElement | null>(null);

  const rows = $derived(launcherRows(query, known));
  const activeIndex = $derived(clampIndex(selected, rows.length));

  // Register with the overlay stack BEFORE the effect that moves focus to the
  // input, so a cancel (Escape / outside click) restores the opener Region.
  useOverlay(
    () => open,
    () => onclose(),
  );
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true;
      query = '';
      selected = 0;
      error = null;
      busy = false;
      queueMicrotask(() => input?.focus());
      void load();
    } else if (!open) {
      wasOpen = false;
    }
  });

  $effect(() => {
    void activeIndex;
    void rows;
    list?.querySelector<HTMLElement>('.row.selected')?.scrollIntoView({ block: 'nearest' });
  });

  async function load() {
    try {
      [known, current] = await Promise.all([backend.listKnownBundles(), backend.bundleRoot()]);
    } catch (e) {
      error = errMessage(e);
    }
  }

  /** Cancel: the same outcome as Escape (restores the opener Region). */
  function cancel() {
    focus.cancelTopOverlay();
  }

  async function choose(path: string, create = false) {
    if (busy) return;
    if (path === current && !create) {
      cancel();
      return;
    }
    busy = true;
    error = null;
    try {
      const unsaved = await beforeSwitch();
      if (unsaved.length > 0) {
        error = `Not switching: ${unsaved.join(', ')} has changes that cannot be saved yet (its frontmatter does not parse). Fix or save it first.`;
        busy = false;
        return;
      }
      await (create ? backend.createBundle(path) : backend.openBundle(path));
      location.reload();
    } catch (e) {
      error = errMessage(e);
      busy = false;
    }
  }

  // `create` makes the picked folder a Bundle: its root `index.md` declares
  // `okf_version` (ov-8).
  async function openNew(create = false) {
    try {
      const picked = await backend.pickFolder();
      if (picked !== null) await choose(picked, create);
    } catch (e) {
      error = errMessage(e);
    }
  }

  async function forget(path: string, ev: MouseEvent) {
    ev.stopPropagation();
    try {
      await backend.forgetBundle(path);
      known = known.filter((b) => b.path !== path);
    } catch (e) {
      error = errMessage(e);
    }
    input?.focus();
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
    // Escape is the global peel's (App → focus.escape), which cancels this overlay.
  }
</script>

{#if open}
  <!-- Backdrop: an outside click cancels (restores the opener). -->
  <div class="bs-backdrop" role="presentation" onclick={cancel}></div>

  <div class="bs-panel" role="dialog" aria-label="Switch Bundle" data-testid="bundle-switcher">
    <input
      bind:this={input}
      bind:value={query}
      class="bs-filter"
      type="text"
      placeholder="Switch to folder…"
      aria-label="Filter folders"
      aria-controls="bundle-switcher-list"
      aria-activedescendant={rows.length > 0 ? `bundle-switcher-row-${activeIndex}` : undefined}
      autocomplete="off"
      spellcheck="false"
      data-testid="bundle-switcher-filter"
      oninput={() => (selected = 0)}
      onkeydown={onKeydown}
    />

    <ul bind:this={list} id="bundle-switcher-list" class="bs-list" role="listbox">
      {#each rows as row, i (row.bundle.path)}
        {@const isCurrent = row.bundle.path === current}
        <li
          id={`bundle-switcher-row-${i}`}
          class="item"
          role="option"
          aria-selected={i === activeIndex}
        >
          <button
            type="button"
            class="row"
            class:selected={i === activeIndex}
            data-testid="bundle-switcher-item"
            data-path={row.bundle.path}
            data-current={isCurrent}
            title={row.bundle.path}
            disabled={busy}
            onmousemove={() => (selected = i)}
            onclick={() => choose(row.bundle.path)}
          >
            <KnownBundleLabel {row} />
            {#if isCurrent}
              <span class="pill">current</span>
            {:else if !row.bundle.exists}
              <span class="pill danger" title="Folder not found on disk">missing</span>
            {/if}
          </button>
          {#if !isCurrent}
            <button
              type="button"
              class="forget"
              data-testid="bundle-switcher-forget"
              data-path={row.bundle.path}
              title="Forget this folder"
              aria-label={`Forget ${row.bundle.name}`}
              onclick={(e) => forget(row.bundle.path, e)}>×</button
            >
          {/if}
        </li>
      {:else}
        <li class="empty">No folders match</li>
      {/each}
    </ul>

    {#if error}
      <p class="error" role="alert" data-testid="bundle-switcher-error">{error}</p>
    {/if}

    <button
      type="button"
      class="open-folder"
      data-testid="bundle-switcher-open-folder"
      disabled={busy}
      onclick={() => openNew()}>Open folder…</button
    >
    <button
      type="button"
      class="open-folder"
      data-testid="bundle-switcher-new-bundle"
      title="Pick a folder and make it an OKF Bundle: its index.md declares okf_version"
      disabled={busy}
      onclick={() => openNew(true)}>New Bundle…</button
    >
  </div>
{/if}

<style>
  .bs-backdrop {
    position: fixed;
    inset: 0;
    z-index: 900;
  }

  /* Anchored beside the switcher button at the top of the 48px left rail. */
  .bs-panel {
    position: fixed;
    top: 0.4rem;
    left: 52px;
    z-index: 901;
    box-sizing: border-box;
    width: min(28rem, calc(100vw - 64px));
    padding: 0.5rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
    font-family: var(--font-ui);
  }

  .bs-filter {
    box-sizing: border-box;
    width: 100%;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: inherit;
    font: inherit;
  }

  .bs-filter:focus {
    outline: 2px solid var(--accent-ring);
    outline-offset: -1px;
  }

  .bs-list {
    list-style: none;
    margin: 0.4rem 0;
    padding: 0;
    max-height: 18rem;
    overflow: auto;
  }

  .item {
    display: flex;
    gap: 0.15rem;
  }

  .row {
    flex: 1 1 auto;
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

  .row:disabled {
    cursor: default;
    opacity: 0.6;
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

  .forget {
    flex: none;
    width: 1.8rem;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: none;
    color: var(--text-faint);
    font: inherit;
    cursor: pointer;
  }

  .forget:hover {
    background: var(--hover);
    color: var(--text);
  }

  .empty {
    padding: 0.6rem;
    color: var(--text-faint);
    font-size: 0.85rem;
  }

  .error {
    margin: 0 0 0.4rem;
    color: var(--danger);
    font-size: 0.8rem;
  }

  .open-folder {
    width: 100%;
    padding: 0.4rem;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-md);
    background: none;
    color: var(--text-muted);
    font: inherit;
    cursor: pointer;
  }

  .open-folder + .open-folder {
    margin-top: 0.3rem;
  }

  .open-folder:hover:not(:disabled) {
    background: var(--hover);
  }
</style>
