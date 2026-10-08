<script lang="ts">
  // The desktop updater's notice for this run (`Backend.onUpdateNotice`): a
  // newer version is installed, queued for exit, or (a `.deb`/`.rpm` install)
  // available to download from its release page. Stays until dismissed.
  import { onMount } from 'svelte';
  import { backend } from '$lib/ipc';
  import type { UpdateNotice } from '$lib/types';
  import { updateNoticeLink, updateNoticeText } from '$lib/updateNotice';

  let notice = $state<UpdateNotice | null>(null);
  let dismissed = $state(false);

  onMount(() =>
    backend.onUpdateNotice((n) => {
      notice = n;
    }),
  );

  const link = $derived(notice ? updateNoticeLink(notice) : null);
</script>

{#if notice && !dismissed}
  <div class="update-notice" role="status" aria-live="polite" data-testid="update-notice">
    <span class="msg">{updateNoticeText(notice)}</span>
    {#if link}
      <a
        href={notice.url}
        data-testid="update-notice-link"
        onclick={(e) => {
          e.preventDefault();
          if (notice) void backend.openExternal(notice.url);
        }}>{link}</a
      >
    {/if}
    <button
      type="button"
      class="dismiss"
      data-testid="update-notice-dismiss"
      aria-label="Dismiss"
      title="Dismiss"
      onclick={() => (dismissed = true)}>×</button
    >
  </div>
{/if}

<style>
  .update-notice {
    position: fixed;
    /* Clear of the right activity rail's zoom buttons. */
    right: 3.75rem;
    bottom: 1rem;
    z-index: 60;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    max-width: min(28rem, calc(100vw - 2rem));
    padding: 0.6rem 0.6rem 0.6rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
    color: var(--text);
    font-size: 0.85rem;
    box-shadow: var(--shadow-md);
  }

  .msg {
    min-width: 0;
  }

  a {
    flex: none;
    color: var(--accent);
    font-weight: 600;
  }

  .dismiss {
    flex: none;
    padding: 0 0.3rem;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 1rem;
    line-height: 1.2;
    cursor: pointer;
  }

  .dismiss:hover {
    background: var(--hover);
  }
</style>
