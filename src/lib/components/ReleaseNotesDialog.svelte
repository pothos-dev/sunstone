<script lang="ts">
  // "What's new" after an update: the changelog sections since the version that
  // ran before, rendered by the desktop backend (`Backend.takeReleaseNotes`) and
  // shown once.
  import { onMount } from 'svelte';
  import { backend } from '$lib/ipc';
  import { useOverlay } from '$lib/state/overlay.svelte';
  import type { ReleaseNotes } from '$lib/types';

  let notes = $state<ReleaseNotes | null>(null);

  useOverlay(
    () => notes !== null,
    () => (notes = null),
  );

  onMount(() => {
    backend
      .takeReleaseNotes()
      .then((n) => (notes = n))
      .catch(() => {});
  });

  // A link in the notes opens in the browser, never inside the app window.
  function openLink(e: MouseEvent): void {
    const a = (e.target as Element | null)?.closest('a');
    if (!a) return;
    e.preventDefault();
    if (/^https?:/.test(a.href)) void backend.openExternal(a.href);
  }
</script>

{#if notes}
  <div class="backdrop" role="presentation" onclick={() => (notes = null)}></div>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="release-notes-title"
    data-testid="release-notes"
  >
    <h1 id="release-notes-title">What’s new in Sunstone</h1>
    <!-- Trusted HTML: the changelog embedded in the app build, rendered in Rust. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="notes" onclick={openLink}>
      {@html notes.html}
    </div>
    <div class="actions">
      <!-- svelte-ignore a11y_autofocus -->
      <button
        type="button"
        data-testid="release-notes-close"
        autofocus
        onclick={() => (notes = null)}>Close</button
      >
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1100;
    background: rgba(16, 22, 18, 0.4);
  }

  .dialog {
    position: fixed;
    z-index: 1101;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    width: min(36rem, calc(100vw - 2rem));
    max-height: min(40rem, calc(100vh - 2rem));
    box-sizing: border-box;
    padding: 1.25rem;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: var(--shadow-lg);
  }

  h1 {
    margin: 0 0 0.75rem;
    font-size: 1.1rem;
  }

  .notes {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    font-size: 0.88rem;
    line-height: 1.5;
  }

  .notes :global(h2) {
    margin: 1rem 0 0.25rem;
    font-size: 0.95rem;
  }

  .notes :global(h2:first-child) {
    margin-top: 0;
  }

  .notes :global(h3) {
    margin: 0.6rem 0 0.2rem;
    color: var(--text-muted);
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .notes :global(ul) {
    margin: 0;
    padding-left: 1.2rem;
  }

  .notes :global(li) {
    margin: 0.2rem 0;
  }

  .notes :global(code) {
    padding: 0.05rem 0.3rem;
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
    font-size: 0.92em;
  }

  .notes :global(a) {
    color: var(--accent);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 1rem;
  }

  .actions button {
    padding: 0.4rem 0.9rem;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--accent-contrast);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
</style>
