<script lang="ts">
  /**
   * Tags Section content for the web viewer.
   *
   * Lists bundle tags with per-tag counts; expanding a tag reveals the Concepts
   * carrying it (`backend.conceptsByTag`, an index query — no scan). Selecting a
   * Concept navigates within the viewer. The tag LIST is supplied by the viewer
   * (which owns the `allTags` fetch so it can hide the whole Section — header
   * included — when the Bundle has no tags, as on desktop); this component only
   * renders the list + lazily loads each expanded tag's Concepts.
   *
   * REUSES the read-only parts of the desktop `TagBrowser`: the conceptsByTag
   * expand + prune-on-`tags` logic, the `basename`/`stripMd` helpers, and the
   * markup / test-ids / styles. It drops the desktop `tagsNav`/`focus` keyboard
   * Region infra (editor-only), using plain clicks + a local expanded Set.
   */
  import { backend } from '$lib/ipc';
  import { basename, stripMd } from '$lib/path';
  import { pruneToLiveTags } from '$lib/tagsNav';
  import type { TagCount } from '$lib/types';

  interface Props {
    /** The bundle's tags + counts (owned by the viewer's allTags fetch). */
    tags: TagCount[];
    /** Bumped on live-reload change events; re-query expanded tags when it changes. */
    version: number;
    /** path of the currently-open Concept, for highlighting. */
    selected: string | null;
    /** Open a Concept (routes through the viewer's path-URL nav). */
    onopen: (path: string) => void;
  }

  let { tags, version, selected, onopen }: Props = $props();

  let expanded = $state(new Set<string>());
  let conceptCache = $state(new Map<string, string[]>());

  // Prune expanded/cache entries whose tag no longer exists (e.g. its last
  // Concept was untagged on disk), keyed on the `tags` prop.
  $effect(() => {
    const live = new Set(tags.map((t) => t.tag));
    const pruned = pruneToLiveTags(live, expanded, conceptCache);
    if (pruned.expanded) expanded = pruned.expanded;
    if (pruned.cache) conceptCache = pruned.cache;
  });

  // Re-query the Concept list for every expanded tag (also on version changes so
  // cached lists stay fresh). The expanded set is the reactive dependency.
  $effect(() => {
    void version;
    const open = [...expanded];
    let cancelled = false;
    for (const tag of open) {
      void backend.conceptsByTag(tag).then((result) => {
        if (cancelled) return;
        const next = new Map(conceptCache);
        next.set(tag, result);
        conceptCache = next;
      });
    }
    return () => {
      cancelled = true;
    };
  });

  function conceptsOf(tag: string): string[] {
    return conceptCache.get(tag) ?? [];
  }

  function toggleTag(tag: string) {
    const next = new Set(expanded);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    expanded = next;
  }

  /** Leaf name of a path, sans `.md` (the full path is on hover). */
  function label(p: string): string {
    return stripMd(basename(p));
  }
</script>

<section class="tag-browser" aria-label="Tags" data-testid="tag-browser">
    <ul class="tag-list" role="tree">
      {#each tags as { tag, count } (tag)}
        {@const open = expanded.has(tag)}
        <li>
          <div
            class="tag"
            data-testid="tag"
            data-tag={tag}
            role="treeitem"
            aria-expanded={open}
            aria-selected="false"
            tabindex="0"
            onclick={() => toggleTag(tag)}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
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
                <li>
                  <div
                    class="concept"
                    class:selected={selected === path}
                    data-testid="tag-concept"
                    data-path={path}
                    title={path}
                    role="treeitem"
                    aria-selected={selected === path}
                    tabindex="0"
                    onclick={() => onopen(path)}
                    onkeydown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
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
</section>

<style>
  .tag-browser {
    padding: 0.4rem 0.35rem;
    font-size: 0.85rem;
    font-family: var(--font-ui, system-ui, sans-serif);
  }

  .tag-list,
  .concept-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

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
    border-radius: var(--radius-sm, 4px);
    transition: background 0.12s ease;
  }

  .tag:hover {
    background: var(--hover, rgba(127, 127, 127, 0.15));
  }

  .twisty {
    flex: 0 0 auto;
    display: inline-block;
    width: 1em;
    transition: transform 0.1s ease;
    color: var(--text-muted, #777);
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
    color: var(--text-faint, #999);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  .concept-list {
    margin: 0.05rem 0 0.15rem;
    padding-left: 0.6rem;
    margin-left: 0.5rem;
    border-left: 1px solid var(--border, #e2e2e2);
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
    border-radius: var(--radius-sm, 4px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: background 0.12s ease;
  }

  .concept:hover {
    background: var(--hover, rgba(127, 127, 127, 0.15));
  }

  .concept.selected {
    background: var(--accent-soft, rgba(217, 98, 43, 0.2));
    color: var(--tag-text, inherit);
  }
</style>
