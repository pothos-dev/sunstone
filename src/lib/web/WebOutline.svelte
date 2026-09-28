<script lang="ts">
  /**
   * Outline Section for the web viewer (slice: web-index-backed-sidebars).
   *
   * Lists the open Concept's headings in document order, indented by level.
   * Selecting one scrolls the rendered view to that heading (the render step
   * gives each heading an `id="<slug>"` matching these slugs). Unlike the desktop
   * `Outline` (which scans editor content + scrolls by line), this rides the
   * `outline` already in the render payload — no extra fetch, no content scan.
   *
   * REUSES the desktop `Outline`'s markup / test-ids / styles (outline,
   * outline-entry, outline-empty), dropping the `outlineNav`/`focus` keyboard
   * Region infra.
   */
  import type { OutlineHeading } from '$lib/types';

  interface Props {
    /** Headings from the render payload (level, text, slug). */
    outline: OutlineHeading[];
    /** Scroll the rendered view to the heading with this slug id. */
    onselect: (slug: string) => void;
  }

  let { outline, onselect }: Props = $props();
</script>

<section class="outline" aria-label="Outline" data-testid="outline">
  {#if outline.length === 0}
    <p class="empty" data-testid="outline-empty">No headings</p>
  {:else}
    <ul class="list">
      {#each outline as heading (heading.slug)}
        <li>
          <button
            type="button"
            class="entry"
            data-testid="outline-entry"
            data-level={heading.level}
            data-slug={heading.slug}
            style="--level: {heading.level - 1}"
            title={heading.text}
            onclick={() => onselect(heading.slug)}
          >
            <span class="name">{heading.text}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .outline {
    padding: 0.4rem 0.35rem;
    font-size: 0.85rem;
  }

  .empty {
    margin: 0;
    color: var(--text-muted, #777);
    font-style: italic;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .entry {
    display: block;
    width: 100%;
    padding: 0.25rem 0.4rem;
    padding-left: calc(0.4rem + var(--level, 0) * 0.85rem);
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius-sm, 4px);
    transition: background 0.12s ease;
  }

  .entry:hover {
    background: var(--hover, rgba(127, 127, 127, 0.15));
  }

  .entry:focus-visible {
    outline: 2px solid var(--accent-ring, #d9622b);
    outline-offset: -2px;
  }

  .name {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
