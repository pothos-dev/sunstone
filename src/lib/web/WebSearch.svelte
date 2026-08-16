<script lang="ts">
  /**
   * Bundle-wide full-text Search for the web viewer (slice: web-full-text-search).
   *
   * A hydrated interactive island: the parent (WebViewer) owns the Ctrl+Shift+F
   * keybinding and toggles `open`. Typing a query is DEBOUNCED then sent to
   * `backend.search` (the HTTP seam → proxied `/api/search` → core ripgrep
   * search). Results list the Concept path, line number and matching line, with
   * the matched substring highlighted. Selecting a hit opens that Concept in the
   * viewer (via the same path-URL routing links use).
   *
   * This REUSES the shared, read-only parts of the desktop `SearchPanel`: the
   * pure `highlightParts` / `listNav` / `splitPath` helpers, the `backend.search`
   * seam, and the same markup / test-ids / styles. It deliberately does NOT
   * depend on the desktop `focus` overlay/Region backbone (editor-only infra the
   * web viewer has no need for), managing open/close/keys locally instead.
   */
  import { backend } from '$lib/ipc';
  import { createLatestGuard } from '$lib/asyncGuard';
  import { highlightParts } from '$lib/highlight';
  import { clampIndex, nextIndex, prevIndex } from '$lib/listNav';
  import { splitPath } from '$lib/path';
  import type { SearchHit } from '$lib/types';

  interface Props {
    /** Whether the panel is open. */
    open: boolean;
    /** Open the chosen Concept (routes through the viewer's path-URL nav). */
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
  // Guards a slow earlier search from overwriting a newer one.
  const queryGuard = createLatestGuard();

  const activeIndex = $derived(clampIndex(selected, results.length));

  // Keep the highlighted result within the scrollable viewport as ↑/↓ moves it.
  $effect(() => {
    void activeIndex;
    void results;
    const el = list?.querySelector<HTMLElement>('.fts-item.selected');
    el?.scrollIntoView({ block: 'nearest' });
  });

  // Reset + focus each time the panel transitions to open. Clears any pending
  // debounce on close.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true;
      query = '';
      results = [];
      selected = 0;
      searching = false;
      queueMicrotask(() => input?.focus());
    } else if (!open) {
      wasOpen = false;
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
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    }
  }
</script>

{#if open}
  <!-- Backdrop: an outside click closes the panel. -->
  <div class="fts-backdrop" role="presentation" onclick={onclose}></div>

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
              <span class="fts-base">{sp.base}</span>
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
  /* Styles mirror the desktop SearchPanel (shared CSS vars from app.css). */
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
    border: 1px solid var(--border, #ccc);
    border-radius: var(--radius-lg, 10px);
    background: var(--bg-elevated, #fff);
    color: var(--text, #222);
    box-shadow: var(--shadow-lg, 0 10px 40px rgba(0, 0, 0, 0.2));
  }

  .fts-input {
    box-sizing: border-box;
    width: 100%;
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--border-strong, #999);
    border-radius: var(--radius-md, 8px);
    background: var(--bg, #fff);
    color: var(--text, #222);
    font-family: var(--font-ui, system-ui, sans-serif);
    font-size: 1rem;
  }

  .fts-input:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--accent-soft, rgba(217, 98, 43, 0.3));
  }

  .fts-hint {
    margin: 0.5rem 0.2rem 0.1rem;
    font-family: var(--font-ui, system-ui, sans-serif);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted, #777);
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
    border-radius: var(--radius-sm, 4px);
    background: none;
    color: var(--text, #222);
    font-family: var(--font-ui, system-ui, sans-serif);
    text-align: left;
    cursor: pointer;
  }

  .fts-item:hover {
    background: var(--hover, rgba(127, 127, 127, 0.15));
  }

  .fts-item.selected {
    background: var(--accent-soft, rgba(217, 98, 43, 0.2));
    color: var(--tag-text, inherit);
  }

  .fts-item:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--accent-soft, rgba(217, 98, 43, 0.3));
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
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.78rem;
    color: var(--text-faint, #999);
  }

  .fts-line {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.74rem;
    color: var(--text-faint, #999);
  }

  .fts-snippet {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.82rem;
    color: var(--text-muted, #777);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .fts-mark {
    background: var(--accent-soft, rgba(217, 98, 43, 0.3));
    color: var(--tag-text, inherit);
    border-radius: var(--radius-sm, 4px);
  }

  .fts-empty {
    padding: 0.5rem 0.55rem;
    color: var(--text-muted, #777);
    font-family: var(--font-ui, system-ui, sans-serif);
    font-size: 0.85rem;
  }
</style>
