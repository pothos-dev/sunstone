<script lang="ts">
  // Outline panel (slice: outline-section).
  //
  // Lists the open Concept's markdown headings, derived LIVE from the editor
  // content (so it updates as the user types), in document order and indented by
  // heading level. Clicking an entry scrolls the editor to that heading's line.
  //
  // The scan (in `$lib/outline`) skips the frontmatter block and fenced code
  // blocks, and tracks line numbers against the FULL document so the scroll
  // target is correct. No active-heading highlight in this slice.
  //
  // Keyboard nav (outline-backlinks-keyboard-nav): the entries form a flat,
  // navigate-and-open Region with roving tabindex — exactly one entry is
  // tab-focusable (the Focused item) and carries the spotlight ring; the rest
  // are `tabindex="-1"`. Arrowing moves the Focused item (clamped at the ends);
  // Enter activates it (App scrolls the Editor + moves focus there). The
  // Focused-index rune lives in `$lib/state/listFocusNav`; App drives DOM focus
  // from it and supplies the keydown routing.

  import { scanHeadings, type OutlineHeading } from '$lib/wasm/exports';
  import { outlineNav } from '$lib/state/listFocusNav.svelte';

  interface Props {
    /** bundle-relative path of the open Concept, or null when none open. */
    path: string | null;
    /** Raw markdown of the open Concept (the editor's live content). */
    content: string;
    /** Scroll the editor to a 1-based full-document line. */
    onselect: (line: number) => void;
  }

  let { path, content, onselect }: Props = $props();

  // Live heading list: recomputed whenever the editor content changes.
  const headings = $derived<OutlineHeading[]>(path === null ? [] : scanHeadings(content));

  // Re-clamp the Focused item into bounds whenever the list shrinks/empties
  // (Concept switch, headings edited away), so the roving tabindex never points
  // past the end.
  $effect(() => {
    outlineNav.clamp(headings.length);
  });
</script>

<section class="outline" aria-label="Outline" data-testid="outline">
  {#if path === null}
    <p class="empty" data-testid="outline-empty">No Concept open</p>
  {:else if headings.length === 0}
    <p class="empty" data-testid="outline-empty">No headings</p>
  {:else}
    <ul class="list">
      {#each headings as heading, i (heading.line)}
        <li>
          <button
            type="button"
            class="entry"
            class:focused-item={outlineNav.focusedIndex === i}
            data-testid="outline-entry"
            data-level={heading.level}
            data-line={heading.line}
            data-index={i}
            style="--level: {heading.level - 1}"
            title={heading.text}
            tabindex={outlineNav.focusedIndex === i ? 0 : -1}
            onclick={() => {
              outlineNav.setFocused(i);
              onselect(heading.line);
            }}
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
    padding: 0.6rem 0.75rem;
    font-size: 0.85rem;
  }

  .empty {
    margin: 0;
    color: var(--text-muted);
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
    /* Step-indent deeper levels: H1 flush-left, each level adds ~0.85rem. */
    padding: 0.25rem 0.4rem;
    padding-left: calc(0.4rem + var(--level, 0) * 0.85rem);
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: background 0.12s ease;
  }

  .entry:hover {
    background: var(--hover);
  }

  .entry:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -2px;
  }

  /* The Focused item (keyboard cursor) — the spotlight ring. Shown ONLY while
     the entry actually holds focus (`:focus-within`), i.e. while this Region is
     the active Region: the `.focused-item` class persists as the roving tab
     target even when focus is elsewhere, but a remembered cursor in an
     UNFOCUSED Region must not paint a second spotlight. `:focus-within` (not
     `:focus-visible`) because the entry is focused PROGRAMMATICALLY and that
     does not reliably set `:focus-visible`. Matches the Explorer's
     `.row.focused-item:focus-within` affordance. */
  .entry.focused-item:focus-within {
    outline: 2px solid var(--accent-ring);
    outline-offset: -2px;
  }

  .name {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
