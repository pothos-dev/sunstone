<script lang="ts">
  /**
   * Quick-nav palette (slice: quick-nav-palette; tag surfacing + drill-down).
   *
   * A centered command palette bound to Ctrl+K (the parent owns the keybinding
   * and toggles `open`). Typing fuzzy-matches bundle-relative Concept paths AND
   * Bundle tags (mixed by score, tags flagged with a badge); with empty input it
   * shows the per-Bundle recent files (most-recent first). ↑/↓ move the
   * selection; Enter on a Concept opens it THROUGH the navigation/history path
   * (so back/forward keeps working); Enter on a TAG drills in — the list is
   * replaced by the Concepts carrying that tag (same render style), and Escape
   * steps back out to the normal search before it closes the palette.
   */
  import { createLatestGuard } from '$lib/asyncGuard';
  import { fuzzyRank } from '$lib/fuzzy';
  import { clampIndex, nextIndex, prevIndex } from '$lib/listNav';
  import { splitPath, stripMd } from '$lib/path';
  import { focus } from '$lib/state/focus.svelte';

  interface Props {
    /** Whether the palette is open. */
    open: boolean;
    /** All bundle-relative Concept paths to match against. */
    paths: string[];
    /** All Bundle tags to match against (surfaced alongside Concepts). */
    tags: string[];
    /** Recent files (most-recent first), shown when the input is empty. */
    recent: string[];
    /** Resolve the Concepts carrying `tag` (index query, for drill-down). */
    conceptsForTag: (tag: string) => Promise<string[]>;
    /** Open the chosen Concept (routes through editor navigation/history). */
    onopen: (path: string) => void;
    /** Close the palette. */
    onclose: () => void;
    /**
     * Mirrors "the palette is in tag drill-down mode" out to the parent, so its
     * global Escape peel DEFERS to us — one Escape steps out of the tag before
     * the next closes the palette (escape-peel-restore-opener).
     */
    tagActive?: boolean;
  }

  let {
    open,
    paths,
    tags,
    recent,
    conceptsForTag,
    onopen,
    onclose,
    tagActive = $bindable(false),
  }: Props = $props();

  let query = $state('');
  let selected = $state(0);
  let input = $state<HTMLInputElement | null>(null);
  let list = $state<HTMLUListElement | null>(null);

  /**
   * Tag drill-down: the tag whose Concepts the list is currently showing (null =
   * normal search). `tagConcepts` holds the resolved Concept paths; `#tagToken`
   * guards against a slow resolve landing after the user stepped back out or
   * drilled a different tag.
   */
  let tagMode = $state<string | null>(null);
  let tagConcepts = $state<string[]>([]);
  const tagGuard = createLatestGuard();

  // Mirror drill-down state to the parent for the Escape peel (see prop docs).
  $effect(() => {
    tagActive = tagMode !== null;
  });

  // Results. A tagged Concept is rendered exactly like a normal Concept row.
  type Result = { kind: 'concept'; path: string } | { kind: 'tag'; tag: string };
  const results = $derived.by<Result[]>(() => {
    const q = query.trim();

    // Drill-down: the Concepts carrying the active tag, fuzzy-filtered by query.
    if (tagMode !== null) {
      const filtered = q === '' ? tagConcepts : fuzzyRank(q, tagConcepts).map((m) => m.target);
      return filtered.map((path): Result => ({ kind: 'concept', path }));
    }

    // Empty query: recent files (kept only to existing paths so a deleted file
    // never lingers).
    if (q === '') {
      const known = new Set(paths);
      return recent.filter((p) => known.has(p)).map((path): Result => ({ kind: 'concept', path }));
    }

    // Mix Concept and tag matches, best score first (ties: shorter target).
    const scored = [
      ...fuzzyRank(q, paths).map((m) => ({
        r: { kind: 'concept', path: m.target } as Result,
        score: m.score,
        len: m.target.length,
      })),
      ...fuzzyRank(q, tags).map((m) => ({
        r: { kind: 'tag', tag: m.target } as Result,
        score: m.score,
        len: m.target.length,
      })),
    ];
    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.len - b.len));
    return scored.map((s) => s.r);
  });

  // The effective selection, clamped to the current result set without writing
  // back to state (avoids an effect-update loop). `selected` is the user's
  // intent; this derived value is what the UI highlights / Enter opens.
  const activeIndex = $derived(clampIndex(selected, results.length));

  // Keep the highlighted result within the scrollable viewport as the selection
  // moves with ↑/↓ (and wraps at the ends), matching the Search panel.
  $effect(() => {
    // Track activeIndex (and results, so it re-runs after the list changes).
    void activeIndex;
    void results;
    const el = list?.querySelector<HTMLElement>('.qn-item.selected');
    el?.scrollIntoView({ block: 'nearest' });
  });

  // Reset + focus each time the palette transitions to open. Tracks `open` only
  // (NOT query/selected) so it doesn't re-run on every keystroke. On open we also
  // REGISTER with the focus store's overlay stack (slice: escape-peel-restore-
  // opener), capturing the opener Region BEFORE we move focus to the input, so a
  // later CANCEL (Escape/backdrop) restores focus exactly where it came from. The
  // token is dropped on close via ANY path (cancel or commit) so the stack stays
  // clean — commit moves focus to the Concept→Editor, cancel restores the opener.
  let wasOpen = false;
  let overlayId: number | null = null;
  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true;
      query = '';
      selected = 0;
      tagMode = null;
      tagConcepts = [];
      overlayId = focus.pushOverlay(onclose);
      queueMicrotask(() => input?.focus());
    } else if (!open) {
      wasOpen = false;
      if (overlayId !== null) {
        focus.removeOverlay(overlayId);
        overlayId = null;
      }
    }
  });

  function choose(path: string) {
    onopen(path);
    onclose();
  }

  /**
   * Drill into a tag: replace the list with the Concepts carrying it (resolved
   * via the backend index) and reset the query so the drill-down starts fresh.
   * The token guards a slow resolve from landing after another drill / step-out.
   */
  function enterTag(tag: string) {
    tagMode = tag;
    query = '';
    selected = 0;
    tagConcepts = [];
    const token = tagGuard.next();
    void conceptsForTag(tag).then((c) => {
      if (tagGuard.isLatest(token)) tagConcepts = c;
    });
    // A tag row reached by CLICK moves focus to the button (then removed from the
    // DOM as the list swaps); pull focus back to the input so typing filters the
    // drill-down and Escape reaches `onKeydown` to step back out.
    queueMicrotask(() => input?.focus());
  }

  /** Step back out of tag drill-down to the normal search. */
  function exitTag() {
    tagMode = null;
    tagConcepts = [];
    tagGuard.next();
    query = '';
    selected = 0;
  }

  /** Activate a result: open a Concept, or drill into a tag. */
  function activate(r: Result) {
    if (r.kind === 'tag') enterTag(r.tag);
    else choose(r.path);
  }

  /**
   * CANCEL via backdrop click — the same outcome as Escape. Route through the
   * focus store so the opener Region (and its remembered item) is restored, NOT
   * a bare `onclose` (which would leave focus stranded on the backdrop/body).
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
      if (r) activate(r);
    } else if (e.key === 'Escape' && tagMode !== null) {
      // In tag drill-down, Escape steps back to the normal search instead of
      // closing the palette. The global peel DEFERS here (App folds `tagActive`
      // into its `localPeelActive`), so this bubble-phase handler owns the press.
      e.preventDefault();
      e.stopPropagation();
      exitTag();
    }
    // Otherwise Escape is handled by the global capture-phase peel (App.svelte →
    // focus.escape), which CANCELS this overlay and restores focus to the opener
    // Region. Handling it here too would double-fire and skip the opener-restore.
  }
</script>

{#if open}
  <!-- Backdrop: an outside click CANCELS the palette (restores the opener). -->
  <div class="qn-backdrop" role="presentation" onclick={cancel}></div>

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
      <p class="qn-hint" data-testid="quick-nav-hint">Recent files</p>
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
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: var(--shadow-lg);
    font-family: var(--font-ui);
  }

  .qn-input {
    box-sizing: border-box;
    width: 100%;
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 1rem;
  }

  .qn-input:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .qn-hint {
    margin: 0.5rem 0.2rem 0.1rem;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-faint);
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
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .qn-item:hover {
    background: var(--hover);
  }

  .qn-item.selected {
    background: var(--accent-soft);
    color: var(--tag-text);
  }

  .qn-base {
    font-weight: 500;
  }

  .qn-dir {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--text-faint);
  }

  .qn-badge {
    margin-left: auto;
    font-size: 0.68rem;
    padding: 0.05rem 0.35rem;
    border-radius: var(--radius-sm);
    background: var(--tag-bg);
    color: var(--tag-text);
  }

  .qn-empty {
    padding: 0.5rem 0.55rem;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
</style>
