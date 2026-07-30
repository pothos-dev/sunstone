<script lang="ts">
  /**
   * Full-text search panel (slice: full-text-search).
   *
   * A centered overlay bound to Ctrl+Shift+F (the parent owns the keybinding and
   * toggles `open`). Typing a query is DEBOUNCED, then sent to `backend.search`,
   * which scans every Concept body in the Bundle on demand. Results list the
   * matching Concept path, line number, and the matching line (with the matched
   * substring highlighted). Selecting a result opens that Concept THROUGH the
   * navigation/history path and scrolls the editor to the matching line.
   * ↑/↓ move the selection, Enter opens the highlighted result, Escape closes.
   *
   * Style mirrors the QuickNav palette for consistency.
   */
  import { backend } from '$lib/ipc';
  import { createLatestGuard } from '$lib/asyncGuard';
  import { highlightParts } from '$lib/highlight';
  import { clampIndex, nextIndex, prevIndex } from '$lib/listNav';
  import { splitPath, stripMd } from '$lib/path';
  import { focus } from '$lib/state/focus.svelte';
  import type { SearchHit } from '$lib/types';

  interface Props {
    /** Whether the panel is open. */
    open: boolean;
    /** Open the chosen Concept at `line` (routes through editor navigation). */
    onopen: (path: string, line: number) => void;
    /** Close the panel. */
    onclose: () => void;
  }

  let { open, onopen, onclose }: Props = $props();

  /** Debounce: search this long after the user stops typing. */
  const SEARCH_DEBOUNCE_MS = 200;

  let query = $state('');
  let results = $state<SearchHit[]>([]);
  let selected = $state(0);
  let searching = $state(false);
  let input = $state<HTMLInputElement | null>(null);
  let list = $state<HTMLUListElement | null>(null);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Guards against a slow earlier search overwriting a newer one.
  const queryGuard = createLatestGuard();

  const activeIndex = $derived(clampIndex(selected, results.length));

  // Keep the highlighted result within the scrollable viewport as the selection
  // moves with ↑/↓ (and wraps at the ends). Without this, the selection can move
  // past the bottom/top of the capped-height list and scroll off-screen.
  $effect(() => {
    // Track activeIndex (and results, so it re-runs after a new search renders).
    void activeIndex;
    void results;
    const el = list?.querySelector<HTMLElement>('.fts-item.selected');
    el?.scrollIntoView({ block: 'nearest' });
  });

  // Reset + focus each time the panel transitions to open. Tracks `open` only.
  // On open we REGISTER with the focus store's overlay stack (slice: escape-peel-
  // restore-opener), capturing the opener Region BEFORE focus moves to the input,
  // so a CANCEL (Escape/backdrop) restores focus to where it came from. The token
  // is dropped on close via ANY path (commit opens a Concept→Editor; cancel
  // restores the opener).
  let wasOpen = false;
  let overlayId: number | null = null;
  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true;
      query = '';
      results = [];
      selected = 0;
      searching = false;
      overlayId = focus.pushOverlay(onclose);
      queueMicrotask(() => input?.focus());
    } else if (!open) {
      wasOpen = false;
      if (overlayId !== null) {
        focus.removeOverlay(overlayId);
        overlayId = null;
      }
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    }
  });

  function runSearch(q: string) {
    const trimmed = q.trim();
    if (trimmed === '') {
      results = [];
      searching = false;
      return;
    }
    const token = queryGuard.next();
    searching = true;
    void backend.search(trimmed).then((hits) => {
      if (!queryGuard.isLatest(token)) return; // a newer query superseded this one
      results = hits;
      selected = 0;
      searching = false;
    });
  }

  function onInput() {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    const q = query;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runSearch(q);
    }, SEARCH_DEBOUNCE_MS);
  }

  function choose(hit: SearchHit) {
    onopen(hit.path, hit.line);
    onclose();
  }

  /**
   * CANCEL via backdrop click — same outcome as Escape. Route through the focus
   * store so the opener Region (and its remembered item) is restored, NOT a bare
   * `onclose` (which would leave focus stranded on the backdrop/body).
   */
  function cancel() {
    focus.cancelTopOverlay();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selected = nextIndex(activeIndex, results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selected = prevIndex(activeIndex, results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[activeIndex];
      if (r) choose(r);
    }
    // Escape is handled by the global capture-phase peel (App.svelte →
    // focus.escape), which CANCELS this overlay and restores focus to the opener
    // Region. Handling it here too would double-fire and skip the opener-restore.
  }
</script>

{#if open}
  <!-- Backdrop: an outside click CANCELS the panel (restores the opener). -->
  <div class="fts-backdrop" role="presentation" onclick={cancel}></div>

  <div class="fts-panel" role="dialog" aria-modal="true" data-testid="search-panel">
    <!-- svelte-ignore a11y_autofocus -->
    <input
      bind:this={input}
      bind:value={query}
      class="fts-input"
      type="text"
      placeholder="Search Concept contents…"
      aria-label="Full-text search"
      data-testid="search-input"
      autocomplete="off"
      autofocus
      oninput={onInput}
      onkeydown={onKeydown}
    />

    {#if query.trim() !== ''}
      <p class="fts-hint" data-testid="search-status">
        {searching ? 'Searching…' : `${results.length} result${results.length === 1 ? '' : 's'}`}
      </p>
    {/if}

    <ul bind:this={list} class="fts-results" role="listbox" data-testid="search-results">
      {#each results as r, i (`${r.path}:${r.line}`)}
        {@const sp = splitPath(r.path)}
        <li role="option" aria-selected={i === activeIndex}>
          <button
            type="button"
            class="fts-item"
            class:selected={i === activeIndex}
            data-path={r.path}
            data-line={r.line}
            data-testid="search-item"
            onmousemove={() => (selected = i)}
            onclick={() => choose(r)}
          >
            <span class="fts-loc">
              <span class="fts-base">{stripMd(sp.base)}</span>
              {#if sp.dir}<span class="fts-dir">{sp.dir}</span>{/if}
              <span class="fts-line">:{r.line}</span>
            </span>
            <span class="fts-snippet" data-testid="search-snippet">
              {#each highlightParts(r.snippet, query) as part}
                {#if part.match}<mark class="fts-mark">{part.text}</mark>{:else}{part.text}{/if}
              {/each}
            </span>
          </button>
        </li>
      {:else}
        {#if query.trim() !== '' && !searching}
          <li class="fts-empty" data-testid="search-empty">No matches</li>
        {/if}
      {/each}
    </ul>
  </div>
{/if}

<style>
  .fts-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1200;
    background: rgba(16, 22, 18, 0.4);
  }

  .fts-panel {
    position: fixed;
    z-index: 1201;
    top: 12%;
    left: 50%;
    transform: translateX(-50%);
    width: min(640px, 92vw);
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: var(--shadow-lg);
  }

  .fts-input {
    box-sizing: border-box;
    width: 100%;
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 1rem;
  }

  .fts-input:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .fts-hint {
    margin: 0.5rem 0.2rem 0.1rem;
    font-family: var(--font-ui);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  .fts-results {
    list-style: none;
    margin: 0.35rem 0 0;
    padding: 0;
    overflow: auto;
  }

  .fts-item {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    width: 100%;
    padding: 0.4rem 0.55rem;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font-family: var(--font-ui);
    text-align: left;
    cursor: pointer;
  }

  .fts-item:hover {
    background: var(--hover);
  }

  .fts-item.selected {
    background: var(--accent-soft);
    color: var(--tag-text);
  }

  .fts-item:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .fts-loc {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }

  .fts-base {
    font-weight: 500;
  }

  .fts-dir {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--text-faint);
  }

  .fts-line {
    font-family: var(--font-mono);
    font-size: 0.74rem;
    color: var(--text-faint);
  }

  .fts-snippet {
    font-family: var(--font-mono);
    font-size: 0.82rem;
    color: var(--text-muted);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .fts-mark {
    background: var(--accent-soft);
    color: var(--tag-text);
    border-radius: var(--radius-sm);
  }

  .fts-empty {
    padding: 0.5rem 0.55rem;
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-size: 0.85rem;
  }
</style>
