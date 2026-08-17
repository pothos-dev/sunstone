<script lang="ts">
  /**
   * Quick-nav command palette for the web viewer (slice: web-quick-nav-palette).
   *
   * A hydrated interactive island: the parent (WebViewer) owns the Ctrl/Cmd+K
   * keybinding and toggles `open`. Typing fuzzy-matches bundle-relative Concept
   * paths AND Bundle tags (mixed by score, tags flagged with a badge). ↑/↓ move
   * the selection; Enter on a Concept opens it via the viewer's SvelteKit path
   * routing (client-side, no full reload); Enter on a TAG drills in — the list is
   * replaced by the Concepts carrying that tag, and Escape steps back out before
   * it closes the palette.
   *
   * This mirrors the desktop `QuickNav`, but — like `WebSearch` — it REUSES only
   * the shared, read-only parts: the pure `fuzzyRank` / `listNav` / `splitPath`
   * helpers and the read-only HTTP backend (`listConceptPaths` / `allTags` /
   * `conceptsByTag`). It deliberately does NOT depend on the desktop `focus`
   * overlay/Region backbone (editor-only infra), managing open/close/keys locally.
   *
   * "Recent files" (the desktop empty-query view) is unavailable on the read-only
   * web backend, so an empty query browses ALL Concept paths instead.
   */
  import { backend } from '$lib/ipc';
  import { createLatestGuard } from '$lib/asyncGuard';
  import { quickNavResults, type QuickNavResult as Result } from '$lib/quickNavResults';
  import { clampIndex, nextIndex, prevIndex } from '$lib/listNav';
  import { splitPath, stripMd } from '$lib/path';

  interface Props {
    /** Whether the palette is open. */
    open: boolean;
    /** Open the chosen Concept (routes through the viewer's path-URL nav). */
    onopen: (path: string) => void;
    /** Close the palette. */
    onclose: () => void;
  }

  let { open, onopen, onclose }: Props = $props();

  let query = $state('');
  let selected = $state(0);
  let input = $state<HTMLInputElement | null>(null);
  let list = $state<HTMLUListElement | null>(null);

  // Palette data, lazily loaded from the read-only backend the first time the
  // palette opens (kept across opens so repeated Ctrl+K is instant). Only ever
  // fetched on the client (inside the open effect), so SSR never touches it.
  let paths = $state<string[]>([]);
  let tags = $state<string[]>([]);
  let loaded = false;

  // Tag drill-down: the tag whose Concepts the list is currently showing (null =
  // normal search). `tagConcepts` holds the resolved paths; `tagGuard` guards a
  // slow resolve from landing after the user stepped back out / drilled another.
  let tagMode = $state<string | null>(null);
  let tagConcepts = $state<string[]>([]);
  const tagGuard = createLatestGuard();

  // Results (pure building shared with the desktop palette via
  // `quickNavResults`). Empty query browses ALL Concept paths — no recents on
  // the read-only web backend.
  const results = $derived.by<Result[]>(() =>
    quickNavResults({ query, tagMode, tagConcepts, paths, tags, emptyQueryPaths: paths }),
  );

  // The effective selection, clamped to the current result set without writing
  // back to state (avoids an effect-update loop).
  const activeIndex = $derived(clampIndex(selected, results.length));

  // Keep the highlighted result within the scrollable viewport as ↑/↓ moves it.
  $effect(() => {
    void activeIndex;
    void results;
    const el = list?.querySelector<HTMLElement>('.qn-item.selected');
    el?.scrollIntoView({ block: 'nearest' });
  });

  // Reset + focus each time the palette transitions to open (tracks `open` only,
  // so it doesn't re-run on every keystroke). Loads palette data on first open.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true;
      query = '';
      selected = 0;
      tagMode = null;
      tagConcepts = [];
      if (!loaded) {
        loaded = true;
        void backend.listConceptPaths().then((p) => {
          paths = p;
        });
        void backend.allTags().then((t) => {
          tags = t.map((tc) => tc.tag);
        });
      }
      queueMicrotask(() => input?.focus());
    } else if (!open) {
      wasOpen = false;
    }
  });

  function choose(path: string) {
    onopen(path);
    onclose();
  }

  /** Drill into a tag: replace the list with the Concepts carrying it. */
  function enterTag(tag: string) {
    tagMode = tag;
    query = '';
    selected = 0;
    tagConcepts = [];
    const token = tagGuard.next();
    void backend.conceptsByTag(tag).then((c) => {
      if (tagGuard.isLatest(token)) tagConcepts = c;
    });
    // A tag row reached by CLICK moves focus to the button (then removed from the
    // DOM as the list swaps); pull focus back to the input so typing filters and
    // Escape reaches `onKeydown` to step back out.
    queueMicrotask(() => input?.focus());
  }

  /** Step back out of tag drill-down to the normal search. */
  function exitTag() {
    tagMode = null;
    tagConcepts = [];
    tagGuard.next(); // invalidate any in-flight resolve
    query = '';
    selected = 0;
  }

  /** Activate a result: open a Concept, or drill into a tag. */
  function activate(r: Result) {
    if (r.kind === 'tag') enterTag(r.tag);
    else choose(r.path);
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
      if (r) activate(r);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // In tag drill-down, Escape steps back to the normal search first; a second
      // Escape (now out of drill-down) closes the palette.
      if (tagMode !== null) exitTag();
      else onclose();
    }
  }
</script>

{#if open}
  <!-- Backdrop: an outside click closes the palette. -->
  <div class="qn-backdrop" role="presentation" onclick={onclose}></div>

  <div class="qn-panel" role="dialog" aria-modal="true" data-testid="quick-nav">
    <!-- svelte-ignore a11y_autofocus -->
    <input
      bind:this={input}
      bind:value={query}
      class="qn-input"
      type="text"
      placeholder={tagMode !== null ? `Filter #${tagMode}…` : 'Jump to a Concept or #tag…'}
      aria-label="Quick navigation"
      data-testid="quick-nav-input"
      autocomplete="off"
      autofocus
      onkeydown={onKeydown}
    />

    {#if tagMode !== null}
      <p class="qn-hint" data-testid="quick-nav-tag-hint">
        <span class="qn-badge">#{tagMode}</span> Concepts — Esc to go back
      </p>
    {:else if query.trim() === ''}
      <p class="qn-hint" data-testid="quick-nav-hint">All Concepts</p>
    {/if}

    <ul bind:this={list} class="qn-results" role="listbox" data-testid="quick-nav-results">
      {#each results as r, i (r.kind === 'tag' ? `tag:${r.tag}` : `concept:${r.path}`)}
        <li role="option" aria-selected={i === activeIndex}>
          {#if r.kind === 'tag'}
            <button
              type="button"
              class="qn-item"
              class:selected={i === activeIndex}
              data-tag={r.tag}
              data-testid="quick-nav-tag"
              onmousemove={() => (selected = i)}
              onclick={() => enterTag(r.tag)}
            >
              <span class="qn-base">#{r.tag}</span>
              <span class="qn-badge">tag</span>
            </button>
          {:else}
            {@const sp = splitPath(r.path)}
            <button
              type="button"
              class="qn-item"
              class:selected={i === activeIndex}
              data-path={r.path}
              data-testid="quick-nav-item"
              onmousemove={() => (selected = i)}
              onclick={() => choose(r.path)}
            >
              <span class="qn-base">{stripMd(sp.base)}</span>
              {#if sp.dir}<span class="qn-dir">{sp.dir}</span>{/if}
            </button>
          {/if}
        </li>
      {:else}
        <li class="qn-empty" data-testid="quick-nav-empty">No matches</li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  /* Styles mirror the desktop QuickNav (shared CSS vars from app.css). */
  .qn-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1200;
    background: rgba(16, 22, 18, 0.4);
  }

  .qn-panel {
    position: fixed;
    z-index: 1201;
    top: 18%;
    left: 50%;
    transform: translateX(-50%);
    width: min(560px, 90vw);
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    padding: 0.5rem;
    border-radius: var(--radius-lg, 10px);
    border: 1px solid var(--border, #ccc);
    background: var(--bg-elevated, #fff);
    color: var(--text, #222);
    box-shadow: var(--shadow-lg, 0 10px 40px rgba(0, 0, 0, 0.2));
    font-family: var(--font-ui, system-ui, sans-serif);
  }

  .qn-input {
    box-sizing: border-box;
    width: 100%;
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--border-strong, #999);
    border-radius: var(--radius-md, 8px);
    background: var(--bg, #fff);
    color: var(--text, #222);
    font: inherit;
    font-size: 1rem;
  }

  .qn-input:focus-visible {
    outline: none;
    border-color: var(--accent, #d9622b);
    box-shadow: 0 0 0 3px var(--accent-soft, rgba(217, 98, 43, 0.3));
  }

  .qn-hint {
    margin: 0.5rem 0.2rem 0.1rem;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-faint, #999);
  }

  .qn-results {
    list-style: none;
    margin: 0.35rem 0 0;
    padding: 0;
    overflow: auto;
  }

  .qn-item {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0.55rem;
    border: none;
    border-radius: var(--radius-sm, 4px);
    background: none;
    color: var(--text, #222);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .qn-item:hover {
    background: var(--hover, rgba(127, 127, 127, 0.15));
  }

  .qn-item.selected {
    background: var(--accent-soft, rgba(217, 98, 43, 0.2));
    color: var(--tag-text, inherit);
  }

  .qn-base {
    font-weight: 500;
  }

  .qn-dir {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.78rem;
    color: var(--text-faint, #999);
  }

  .qn-badge {
    margin-left: auto;
    font-size: 0.68rem;
    padding: 0.05rem 0.35rem;
    border-radius: var(--radius-sm, 4px);
    background: var(--tag-bg, rgba(127, 127, 127, 0.15));
    color: var(--tag-text, inherit);
  }

  .qn-empty {
    padding: 0.5rem 0.55rem;
    color: var(--text-muted, #777);
    font-size: 0.85rem;
  }
</style>
