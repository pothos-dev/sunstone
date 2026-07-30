<script lang="ts">
  // Tag browser (slice 8; multi-expand + keyboard nav: tags-multi-expand-keyboard-nav).
  //
  // Lists all tags across the Bundle with per-tag counts (`backend.allTags`).
  // A tag root is styled like an Explorer folder row (twisty + name + count);
  // expanding it reveals the Concepts carrying it (`backend.conceptsByTag`, an
  // index query — no frontend scan) as nested leaves. Selecting a Concept opens
  // it through `onopen` (navigation/history).
  //
  // MULTI-EXPAND: like the Explorer's folders, several tags can stay open at
  // once. `expanded` is a Set of open tags (not a single `activeTag`), and the
  // revealed Concepts are held in a PER-TAG cache (`conceptCache`, keyed by tag)
  // queried lazily on each expand.
  //
  // Refresh: like the backlinks panel, we thread the index `version` signal
  // (bumped on every `file-changed` refresh) as a reactive dependency, so the
  // tag list — and every expanded tag's cached Concept list — re-query when
  // frontmatter tags change on disk, without a bespoke refresh mechanism. Tags
  // that no longer exist are dropped from the expanded set + cache.
  //
  // KEYBOARD NAV: the Tags Region gets a Focused item (a row — a tag root or a
  // concept leaf) with roving tabindex (exactly one `tabindex="0"`) and the
  // spotlight ring, mirroring the Explorer. The pure key handling lives in
  // `$lib/state/tagsNav` (index math from `$lib/tagsNav`); this component wires
  // the local `onkeydown` and mirrors the Focused-item key into DOM focus.
  // There are deliberately NO CRUD verbs here — tags derive from frontmatter.

  import { backend } from '$lib/ipc';
  import { createCancelGuard } from '$lib/asyncGuard';
  import { stripMd } from '$lib/path';
  import type { TagCount } from '$lib/types';
  import { focus } from '$lib/state/focus.svelte';
  import { tagsNav } from '$lib/state/tagsNav.svelte';
  import { rowKey } from '$lib/tagsNav';

  interface Props {
    /** Index version signal; re-query when it bumps (file-changed). */
    version: number;
    /** path of the currently-open Concept, for highlighting. */
    selected: string | null;
    /** Open a Concept (routes through navigation/history) — mouse click. */
    onopen: (path: string) => void;
    /**
     * Open a Concept AND move focus to the Editor — used by keyboard Enter on a
     * concept leaf (docs/GLOSSARY.md: opening from a Region moves focus to the
     * Editor). Defaults to `onopen` when not supplied.
     */
    onopenFocus?: (path: string) => void;
  }

  let { version, selected, onopen, onopenFocus = onopen }: Props = $props();

  let tags = $state<TagCount[]>([]);
  /** The set of expanded tags (multi-expand). */
  let expanded = $state(new Set<string>());
  /** Per-tag cache of the Concepts carrying each expanded tag. */
  let conceptCache = $state(new Map<string, string[]>());

  /** The container hosting the rows — used to mirror the Focused item into DOM focus. */
  let host = $state<HTMLElement | null>(null);

  // Load all tags whenever the index version changes. Drop any expanded tag /
  // cache entry whose tag no longer exists (e.g. its last Concept was untagged).
  $effect(() => {
    void version;
    const guard = createCancelGuard();
    void backend.allTags().then((result) => {
      if (guard.isCancelled()) return;
      tags = result;
      const live = new Set(result.map((t) => t.tag));
      // Prune expanded tags that vanished.
      let prunedExpanded = false;
      const nextExpanded = new Set<string>();
      for (const t of expanded) {
        if (live.has(t)) nextExpanded.add(t);
        else prunedExpanded = true;
      }
      if (prunedExpanded) expanded = nextExpanded;
      // Prune cache entries that vanished.
      let prunedCache = false;
      const nextCache = new Map<string, string[]>();
      for (const [t, c] of conceptCache) {
        if (live.has(t)) nextCache.set(t, c);
        else prunedCache = true;
      }
      if (prunedCache) conceptCache = nextCache;
    });
    return () => guard.cancel();
  });

  // Re-query the Concept list for every expanded tag, also re-running on version
  // changes so cached lists stay fresh as frontmatter tags change on disk. The
  // expanded set is the reactive dependency; each expand triggers a (cached) fill.
  $effect(() => {
    void version;
    const open = [...expanded];
    const guard = createCancelGuard();
    for (const tag of open) {
      void backend.conceptsByTag(tag).then((result) => {
        if (guard.isCancelled()) return;
        // Replace the Map so the change is observed by the reactive read below.
        const next = new Map(conceptCache);
        next.set(tag, result);
        conceptCache = next;
      });
    }
    return () => guard.cancel();
  });

  /** Concepts cached for `tag` (empty until the query for an expand resolves). */
  function conceptsOf(tag: string): string[] {
    return conceptCache.get(tag) ?? [];
  }

  function isExpanded(tag: string): boolean {
    return expanded.has(tag);
  }

  function setExpanded(tag: string, open: boolean) {
    const next = new Set(expanded);
    if (open) next.add(tag);
    else next.delete(tag);
    expanded = next;
  }

  function toggleTag(tag: string) {
    setExpanded(tag, !isExpanded(tag));
  }

  // Within-Tags keyboard navigation. Routes the unmodified arrow/hjkl/Enter/Home/
  // End keys to the `tagsNav` store; cross-Region movement (Alt+dir) + Escape
  // stay in App's global capture handler. The store moves the Focused item (a
  // row) independently of the open Concept; the effect below mirrors it to DOM.
  function onKeydown(e: KeyboardEvent) {
    const handled = tagsNav.handleKeydown(e, tags, conceptsOf, {
      isExpanded,
      setExpanded,
      openConcept: onopenFocus,
    });
    if (handled) e.preventDefault();
  }

  // Seed the Focused item when the Tags Region gains focus with nothing focused
  // yet (e.g. entered via Alt-movement): land on the first tag root so a row is
  // tab-focusable and the spotlight ring shows immediately. Stays a no-op once a
  // row is focused, and when the Region isn't active (a click sets it directly).
  $effect(() => {
    if (focus.focusedRegion !== 'tags') return;
    if (tagsNav.focusedKey !== null) return;
    if (tags.length === 0) return;
    tagsNav.setFocused(rowKey(tags[0].tag, null));
  });

  // Mirror the Focused-item key into DOM focus: when the keyboard cursor moves,
  // focus the matching row element so the region backbone records it as the
  // Tags Region's remembered item and the active-Region highlight tracks it.
  // Only acts while the Tags Region holds focus (so a click elsewhere or a
  // programmatic change can't steal focus). Mirrors the Explorer's effect.
  $effect(() => {
    const key = tagsNav.focusedKey;
    if (key === null || !host) return;
    if (focus.focusedRegion !== 'tags') return;
    const row = host.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`);
    if (row && document.activeElement !== row) row.focus();
  });

  /** A Concept leaf's label: the FULL bundle-relative path, sans `.md` — mirrors
   *  the Backlinks panel so same-named Concepts in different folders are
   *  disambiguated by their path (e.g. `concepts/editor/live-preview`). */
  function label(p: string): string {
    return stripMd(p);
  }
</script>

<section class="tag-browser" aria-label="Tags" data-testid="tag-browser" bind:this={host}>
  {#if tags.length === 0}
    <p class="empty" data-testid="tags-empty">No tags</p>
  {:else}
    <ul class="tag-list" role="tree" tabindex="-1" onkeydown={onKeydown}>
      {#each tags as { tag, count } (tag)}
        {@const tagKey = rowKey(tag, null)}
        {@const open = expanded.has(tag)}
        {@const tagFocused = tagsNav.focusedKey === tagKey}
        <li>
          <div
            class="tag"
            class:focused-item={tagFocused}
            data-testid="tag"
            data-tag={tag}
            data-row-key={tagKey}
            role="treeitem"
            aria-expanded={open}
            aria-selected="false"
            tabindex={tagFocused ? 0 : -1}
            onclick={() => {
              tagsNav.setFocused(tagKey);
              toggleTag(tag);
            }}
            onkeydown={(e) => {
              // Space/Enter on the row toggles too (native button affordance);
              // arrow keys are handled by the section-level handler above.
              if (e.key === ' ') {
                e.preventDefault();
                tagsNav.setFocused(tagKey);
                toggleTag(tag);
              }
            }}
          >
            <span class="twisty" class:open>▸</span>
            <span class="tag-name">{tag}</span>
            <span class="count" data-testid="tag-count">{count}</span>
          </div>

          {#if open}
            <ul class="concept-list" data-testid="tag-concepts">
              {#each conceptsOf(tag) as path (path)}
                {@const leafKey = rowKey(tag, path)}
                {@const leafFocused = tagsNav.focusedKey === leafKey}
                <li>
                  <div
                    class="concept"
                    class:selected={selected === path}
                    class:focused-item={leafFocused}
                    data-testid="tag-concept"
                    data-path={path}
                    data-row-key={leafKey}
                    title={path}
                    role="treeitem"
                    aria-selected={selected === path}
                    tabindex={leafFocused ? 0 : -1}
                    onclick={() => {
                      tagsNav.setFocused(leafKey);
                      onopen(path);
                    }}
                    onkeydown={(e) => {
                      // Space opens too (native button affordance); Enter and the
                      // arrow keys are handled by the section-level handler above.
                      if (e.key === ' ') {
                        e.preventDefault();
                        tagsNav.setFocused(leafKey);
                        onopen(path);
                      }
                    }}
                  >
                    {label(path)}
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .tag-browser {
    padding: 0.6rem 0.75rem;
    font-size: 0.85rem;
    font-family: var(--font-ui);
  }

  .tag-browser:focus {
    outline: none;
  }

  .empty {
    margin: 0;
    color: var(--text-muted);
    font-style: italic;
  }

  .tag-list,
  .concept-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* A tag is a collapsible root, styled like an Explorer folder row: a
     disclosure twisty, the tag name, then a trailing count. Expanding reveals
     the tagged Concepts as nested leaves (mirroring the tree's children). */
  .tag {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: 100%;
    padding: 0.15rem 0.4rem;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: background 0.12s ease;
  }

  .tag:hover {
    background: var(--hover);
  }

  /* The Focused item (keyboard cursor) — the spotlight ring. Distinct from the
     open Concept's filled accent (`.concept.selected`). Shown ONLY while the
     row actually holds focus (`:focus-within`), i.e. while the Tags Region is
     the active Region: the `.focused-item` class persists as the roving tab
     target even when focus is elsewhere, but a remembered cursor in an
     UNFOCUSED Region must not paint a second spotlight. `:focus-within` (not
     `:focus-visible`) because rows are focused PROGRAMMATICALLY. The higher
     specificity also beats `.tag:focus { outline: none }` while focused. */
  .tag:focus,
  .concept:focus {
    outline: none;
  }

  .tag.focused-item:focus-within,
  .concept.focused-item:focus-within {
    outline: 2px solid var(--accent-ring);
    outline-offset: -1px;
  }

  .twisty {
    flex: 0 0 auto;
    display: inline-block;
    width: 1em;
    transition: transform 0.1s ease;
    color: var(--text-muted);
  }

  .twisty.open {
    transform: rotate(90deg);
  }

  .tag-name {
    flex: 1 1 auto;
    min-width: 0;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    flex: 0 0 auto;
    color: var(--text-faint);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  .concept-list {
    margin: 0.05rem 0 0.15rem;
    padding-left: 0.6rem;
    margin-left: 0.5rem;
    border-left: 1px solid var(--border);
  }

  .concept {
    width: 100%;
    padding: 0.2rem 0.4rem;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: background 0.12s ease;
  }

  .concept:hover {
    background: var(--hover);
  }

  .concept.selected {
    background: var(--accent-soft);
    color: var(--tag-text);
  }
</style>
