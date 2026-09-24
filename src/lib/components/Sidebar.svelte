<script lang="ts">
  // The desktop shell's collapsible Sidebar: the `<aside>` (clipping outer +
  // fixed-width inner) together with its resize border. Both Sidebars in
  // App.svelte are this same pattern; only the side, labels, test ids and the
  // content differ. It renders two SIBLINGS (no wrapper) — the aside and its
  // edge slot, ordered by side — so each still takes its own column of App's
  // shell grid.
  //
  // Collapsing lives on the ActivityRail's toggle button, so the border is
  // absent while the Sidebar is collapsed; the empty 0-width `.edge-slot` keeps
  // the remaining shell children in their own grid columns either way.
  import type { Snippet } from 'svelte';
  import SidebarEdge from './SidebarEdge.svelte';
  import type { SidebarSide } from '$lib/sidebarResize';

  interface Props {
    side: SidebarSide;
    /** Expanded (true) or collapsed to 0 width. */
    open: boolean;
    /** The persisted content width in px. */
    width: number;
    /** The aside's accessible name. */
    label: string;
    /** Accessible noun for the resize border ("Resize <edgeLabel>"). */
    edgeLabel: string;
    /** Test id of the aside. */
    testid: string;
    /** Test id of the resize border. */
    edgeTestid: string;
    /** How many Sections are expanded (drives SidebarSection's share, via CSS). */
    expandedCount: number;
    /** Report a new width while drag / Arrow-key resizing. */
    onResize: (width: number) => void;
    children: Snippet;
  }

  let {
    side,
    open,
    width,
    label,
    edgeLabel,
    testid,
    edgeTestid,
    expandedCount,
    onResize,
    children,
  }: Props = $props();

  // True while an edge drag is in progress: suppresses the width transition.
  let resizing = $state(false);
</script>

{#snippet edge()}
  <div class="edge-slot">
    {#if open}
      <SidebarEdge
        {side}
        {width}
        label={edgeLabel}
        testid={edgeTestid}
        {onResize}
        onResizeStart={() => (resizing = true)}
        onResizeEnd={() => (resizing = false)}
      />
    {/if}
  </div>
{/snippet}

{#if side === 'right'}{@render edge()}{/if}
<aside
  class="side-bar"
  class:right-side-bar={side === 'right'}
  class:collapsed={!open}
  class:resizing
  aria-label={label}
  data-testid={testid}
  style="width: {open ? width : 0}px; --side-w: {width}px; --expanded-count: {expandedCount}"
>
  <div class="side-bar-inner">
    {@render children()}
  </div>
</aside>
{#if side === 'left'}{@render edge()}{/if}

<style>
  /* A stable grid column for the Sidebar's resize edge (see the header). */
  .edge-slot {
    display: flex;
    height: 100vh;
  }

  .side-bar {
    /* Width is driven inline from the persisted width (0 when collapsed). The
       inner keeps the FULL width (via `--side-w`) so collapsing slides the
       content out under the clip rather than reflowing it. */
    height: 100vh;
    overflow: hidden;
    display: flex;
    justify-content: flex-end;
    /* No border on the aside itself: the adjacent SidebarEdge draws the single
       1px seam (matching the rail's border). A border here too would double it. */
    background: var(--bg-elevated);
    transition: width 0.22s ease;
  }

  /* Suppress the transition while dragging the edge so the width tracks the
     pointer instantly. */
  .side-bar.resizing {
    transition: none;
  }

  .right-side-bar {
    justify-content: flex-start;
  }

  .side-bar-inner {
    flex: none;
    width: var(--side-w, 280px);
    height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;
    font-size: 0.9rem;
  }
</style>
