<script lang="ts">
  /**
   * The settings page (desktop only): a dialog with a sidebar of sections —
   * Appearance (with the colour-theme picker as a subpage), Fonts, Layout and
   * Keyboard. Opened by the rail's gear or the `settings` shortcut (Ctrl/Cmd+,).
   *
   * Every change previews at once and is saved on its own (`state/settings.svelte.ts`);
   * only the settings the user touches are written to config.json.
   *
   * The dialog owns its keys: App's global handler skips events from inside
   * it (`data-settings-dialog`), so recording Ctrl+K rebinds instead of opening
   * Quick open. Escape peels one layer here — a recording, then the subpage,
   * then the dialog itself (as the cancel of the overlay stack).
   */
  import { focus } from '$lib/state/focus.svelte';
  import { useOverlay } from '$lib/state/overlay.svelte';
  import { settings } from '$lib/state/settings.svelte';
  import { commandForEvent } from '$lib/settings/keybindings';
  import type { SettingsPageId } from '$lib/settings/settingsPage';
  import AppearancePage from './AppearancePage.svelte';
  import ColorThemePage from './ColorThemePage.svelte';
  import FontsPage from './FontsPage.svelte';
  import LayoutPage from './LayoutPage.svelte';
  import KeyboardPage from './KeyboardPage.svelte';

  interface Props {
    open: boolean;
    onclose: () => void;
  }
  let { open, onclose }: Props = $props();

  const PAGES: { id: SettingsPageId; label: string; icon: string }[] = [
    { id: 'appearance', label: 'Appearance', icon: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 1.5v9a4.5 4.5 0 0 0 0-9Z' },
    { id: 'fonts', label: 'Fonts', icon: 'M3 13 7 3h2l4 10h-1.7l-1-2.6H5.7l-1 2.6H3Zm3.3-4.1h3.4L8 4.6 6.3 8.9Z' },
    { id: 'layout', label: 'Layout', icon: 'M2.5 3h11v10h-11V3Zm1.3 1.3v7.4h2.9V4.3H3.8Zm4.2 0v7.4h4.2V4.3H8Z' },
    {
      id: 'keyboard',
      label: 'Keyboard',
      icon: 'M1.5 4.5h13v7h-13v-7Zm2 1.5v1.3h1.3V6H3.5Zm2.6 0v1.3h1.3V6H6.1Zm2.6 0v1.3H10V6H8.7Zm2.6 0v1.3h1.3V6h-1.3ZM5 8.7V10h6V8.7H5Z',
    },
  ];

  let page = $state<SettingsPageId>('appearance');
  let subpage = $state<'colorTheme' | null>(null);
  let recording = $state<string | null>(null);
  let dialog = $state<HTMLElement | null>(null);

  useOverlay(
    () => open,
    () => {
      // Write what is pending now rather than after the debounce.
      void settings.flush();
      onclose();
    },
  );

  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      subpage = null;
      recording = null;
      queueMicrotask(() => dialog?.focus());
    }
    wasOpen = open;
  });

  function go(id: SettingsPageId) {
    page = id;
    subpage = null;
    recording = null;
  }

  function close() {
    focus.cancelTopOverlay();
  }

  function onKeydown(e: KeyboardEvent) {
    if (commandForEvent(e, settings.keybindings, 'app') === 'settings') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    if (subpage !== null) {
      subpage = null;
      dialog?.focus();
    } else {
      close();
    }
  }

  const title = $derived(PAGES.find((p) => p.id === page)?.label ?? '');
</script>

{#if open}
  <div class="backdrop" role="presentation" onclick={close}></div>

  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={dialog}
    class="settings-dialog"
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
    tabindex="-1"
    data-settings-dialog
    data-testid="settings-dialog"
    onkeydown={onKeydown}
    onfocusout={(e) => e.stopPropagation()}
  >
    <nav class="nav" aria-label="Settings sections">
      <div class="nav-title">Settings</div>
      {#each PAGES as p (p.id)}
        <button
          type="button"
          class="nav-item"
          class:active={page === p.id}
          aria-current={page === p.id ? 'page' : undefined}
          data-testid="settings-nav-{p.id}"
          onclick={() => go(p.id)}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"
            ><path d={p.icon} fill="currentColor" fill-rule="evenodd" /></svg
          >
          {p.label}
        </button>
      {/each}
      <p class="nav-foot">Changes apply and save as you make them.</p>
    </nav>

    <section class="body">
      <header class="head">
        {#if subpage === 'colorTheme'}
          <button type="button" class="icon-btn back" aria-label="Back to Appearance" onclick={() => (subpage = null)}>‹</button>
          <h2>
            <button type="button" class="crumb" onclick={() => (subpage = null)}>Appearance</button>
            <span class="sep">›</span> Colour theme
          </h2>
        {:else}
          <h2>{title}</h2>
        {/if}
        <button type="button" class="icon-btn" aria-label="Close settings" data-testid="settings-close" onclick={close}>×</button>
      </header>

      {#if settings.error}
        <p class="error" role="alert" data-testid="settings-error">Could not save to config.json: {settings.error}</p>
      {/if}

      <div class="scroll">
        {#if page === 'appearance' && subpage === 'colorTheme'}
          <ColorThemePage />
        {:else if page === 'appearance'}
          <AppearancePage onbrowse={() => (subpage = 'colorTheme')} />
        {:else if page === 'fonts'}
          <FontsPage />
        {:else if page === 'layout'}
          <LayoutPage />
        {:else}
          <KeyboardPage bind:recording />
        {/if}
      </div>
    </section>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1300;
    background: color-mix(in srgb, var(--bg-sunken) 55%, transparent);
    backdrop-filter: blur(2px);
  }

  .settings-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 1301;
    display: grid;
    grid-template-columns: 13rem 1fr;
    width: min(56rem, 92vw);
    height: min(38rem, 85vh);
    overflow: hidden;
    transform: translate(-50%, -50%);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.22);
    font-family: var(--font-ui);
    outline: none;
  }

  .nav {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 1rem 0.6rem;
    border-right: 1px solid var(--border);
    background: var(--bg-sunken);
  }
  .nav-title {
    padding: 0 0.6rem 0.7rem;
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.45rem 0.6rem;
    border: 0;
    border-radius: var(--radius-md);
    background: none;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .nav-item svg {
    color: var(--text-muted);
  }
  .nav-item:hover {
    background: var(--hover);
  }
  .nav-item:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -2px;
  }
  .nav-item.active {
    background: var(--accent-soft);
    font-weight: 500;
  }
  .nav-item.active svg {
    color: var(--accent);
  }
  .nav-foot {
    margin: auto 0 0;
    padding: 0 0.6rem;
    color: var(--text-faint);
    font-size: 0.75rem;
    line-height: 1.45;
  }

  .body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.9rem 1rem 0.7rem 1.5rem;
    border-bottom: 1px solid var(--border);
  }
  .head h2 {
    flex: 1;
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
  }
  .crumb {
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-muted);
    font: inherit;
    cursor: pointer;
  }
  .crumb:hover {
    color: var(--accent);
  }
  .sep {
    color: var(--text-faint);
    font-weight: 400;
  }
  .icon-btn {
    width: 1.9rem;
    height: 1.9rem;
    border: 0;
    border-radius: var(--radius-md);
    background: none;
    color: var(--text-muted);
    font-size: 1.3rem;
    line-height: 1;
    cursor: pointer;
  }
  .icon-btn.back {
    margin-left: -0.6rem;
  }
  .icon-btn:hover {
    background: var(--hover);
    color: var(--text);
  }
  .icon-btn:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -2px;
  }
  .error {
    margin: 0.6rem 1.5rem 0;
    padding: 0.45rem 0.7rem;
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
    font-size: 0.85rem;
  }
  .scroll {
    flex: 1;
    overflow: auto;
    padding: 0.4rem 1.5rem 2rem;
  }

  /* Primitives the pages share. */
  .settings-dialog :global(.row) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    padding: 0.95rem 0;
    border-bottom: 1px solid var(--border);
  }
  .settings-dialog :global(.row.flat) {
    padding: 0;
    border-bottom: 0;
  }
  .settings-dialog :global(.label) {
    min-width: 0;
  }
  .settings-dialog :global(.name) {
    display: flex;
    align-items: center;
    font-weight: 500;
  }
  .settings-dialog :global(.hint) {
    margin-top: 0.15rem;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .settings-dialog :global(.intro) {
    margin: 0.8rem 0 0.3rem;
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .settings-dialog :global(.control) {
    display: flex;
    flex: none;
    align-items: center;
    gap: 0.35rem;
  }
  .settings-dialog :global(.set-dot) {
    flex: none;
    width: 0.4rem;
    height: 0.4rem;
    margin-right: 0.45rem;
    border-radius: 50%;
    background: var(--accent);
  }
  .settings-dialog :global(.segmented) {
    display: inline-flex;
    padding: 0.15rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-sunken);
  }
  .settings-dialog :global(.segmented button) {
    padding: 0.3rem 0.85rem;
    border: 0;
    border-radius: calc(var(--radius-md) - 2px);
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.875rem;
    cursor: pointer;
  }
  .settings-dialog :global(.segmented button.on) {
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  }
  .settings-dialog :global(.segmented button:focus-visible) {
    outline: 2px solid var(--accent-ring);
    outline-offset: -2px;
  }
  .settings-dialog :global(.switch) {
    position: relative;
    width: 2.1rem;
    height: 1.2rem;
    margin: 0;
    border-radius: var(--radius-pill);
    background: var(--border-strong);
    cursor: pointer;
    transition: background 120ms;
    appearance: none;
  }
  .settings-dialog :global(.switch::after) {
    content: '';
    position: absolute;
    top: 0.15rem;
    left: 0.15rem;
    width: 0.9rem;
    height: 0.9rem;
    border-radius: 50%;
    background: var(--bg-elevated);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    transition: transform 120ms;
  }
  .settings-dialog :global(.switch:checked) {
    background: var(--accent);
  }
  .settings-dialog :global(.switch:checked::after) {
    transform: translateX(0.9rem);
  }
  .settings-dialog :global(.switch:focus-visible) {
    outline: 2px solid var(--accent-ring);
    outline-offset: 2px;
  }
  .settings-dialog :global(kbd) {
    min-width: 1.1rem;
    padding: 0.05rem 0.35rem;
    border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    border-radius: 4px;
    background: var(--bg);
    color: var(--text);
    font: 0.75rem var(--font-ui);
    text-align: center;
  }
</style>
