<script lang="ts">
  /**
   * One Reserved-file icon button (slice: reserved-files): the outline icon
   * that opens a Bundle's `index.md` / `log.md` directly. Two placements share
   * the markup (accessible name, `data-reserved-*` stamps) and differ only in
   * chrome:
   *   - `header` — the Explorer Section header, for the Bundle root: tabbable,
   *     title marked "(Bundle root)".
   *   - `row`    — inside a folder row of the tree: out of the tab order (the
   *     row owns keyboard nav) and the click never reaches the row.
   */
  import { RESERVED_FILES } from '$lib/reserved';
  import ReservedGlyph from '$lib/components/ReservedGlyph.svelte';
  import type { ReservedEntry } from '$lib/treeNav';

  interface Props {
    entry: ReservedEntry;
    /** Whether `entry` is the open Concept. */
    selected: boolean;
    placement: 'header' | 'row';
    onopen: (path: string) => void;
  }

  let { entry, selected, placement, onopen }: Props = $props();

  const label = $derived(`Open ${RESERVED_FILES[entry.kind]}`);
</script>

<button
  type="button"
  class="reserved-btn in-{placement}"
  class:selected
  tabindex={placement === 'row' ? -1 : undefined}
  title={placement === 'header' ? `${label} (Bundle root)` : label}
  aria-label={label}
  data-reserved-path={entry.path}
  data-reserved-kind={entry.kind}
  onclick={(e) => {
    if (placement === 'row') e.stopPropagation();
    onopen(entry.path);
  }}
><ReservedGlyph kind={entry.kind} /></button>

<style>
  /* header: the Bundle-root icons in the Explorer Section header. */
  .reserved-btn.in-header {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.85rem;
    line-height: 1;
    cursor: pointer;
    opacity: 0.75;
    transition: background 0.12s ease;
  }

  .reserved-btn.in-header:hover {
    background: var(--hover);
    opacity: 1;
  }

  .reserved-btn.in-header:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -1px;
    opacity: 1;
  }

  .reserved-btn.in-header.selected {
    background: var(--accent-soft);
    color: var(--tag-text);
    opacity: 1;
  }

  /* row: the per-folder icons inside a tree row. */
  .reserved-btn.in-row {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 1.4rem;
    align-self: stretch;
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.8rem;
    line-height: 1;
    cursor: pointer;
    border-radius: var(--radius-sm);
    opacity: 0.55;
    transition: background 0.12s ease;
  }

  .reserved-btn.in-row:hover {
    background: var(--hover);
    opacity: 1;
  }

  .reserved-btn.in-row.selected {
    opacity: 1;
    background: var(--accent-soft);
    color: var(--tag-text);
  }

  .reserved-btn.in-row:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -1px;
  }
</style>
