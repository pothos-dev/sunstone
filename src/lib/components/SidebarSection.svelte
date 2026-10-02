<script lang="ts">
  // VSCode-style collapsible sidebar section (an "accordion" tile).
  //
  // The header is always visible and toggles the body. When expanded the body
  // sizes to its natural content height but is capped so the expanded sections
  // share the viewport: the cap is `viewport / number-of-expanded-sections`
  // (≈1/3 each when all three are open, 1/2 when one is collapsed, full when two
  // are). The expanded count is supplied by the parent as the `--expanded-count`
  // CSS custom property on the sidebar container, so the cap is pure CSS and
  // updates reactively as sections open/close. `flex-shrink` + `min-height: 0`
  // guarantee everything fits the viewport even if header heights drift from the
  // 2rem assumed by the cap formula; overflow scrolls within each body.
  import type { Snippet } from 'svelte';
  import { region, type RegionParams } from '$lib/region';
  import { focus } from '$lib/state/focus.svelte';

  interface Props {
    /** Section title shown in the always-visible header. */
    title: string;
    /** Whether the body is shown. Owned by the parent (drives the cap). */
    expanded: boolean;
    /** Toggle handler (the parent flips its own state). */
    ontoggle: () => void;
    /** Click on the header title; defaults to `ontoggle`. The chevron always toggles. */
    ontitleclick?: () => void;
    /** Optional test id; the header/body get `${testid}-header`/`-body`. */
    testid?: string;
    /** Optional header actions, rendered beside the title (always visible, even
        when collapsed). Kept outside the toggle button so clicks don't toggle. */
    actions?: Snippet;
    /**
     * Optional focus-backbone Region wiring. When supplied, the body element is
     * registered as this Region and stays MOUNTED even while the Section is
     * collapsed — so directional focus can target it and transiently REVEAL it
     * (flip `expanded` open) on the way in. Only the body's CONTENT is gated by
     * `expanded`, so a collapsed Section still unmounts its panel. Without this,
     * the body is simply `{#if expanded}` (no Region, content removed when shut).
     */
    region?: RegionParams;
    /** Body content. */
    children: Snippet;
  }

  let {
    title,
    expanded,
    ontoggle,
    ontitleclick,
    testid,
    actions,
    region: regionParams,
    children,
  }: Props = $props();
</script>

<section class="section" data-testid={testid} aria-label={title}>
  <!-- Chevron and title are two controls: the chevron always toggles, the title
       runs `ontitleclick` (default: toggle). Optional header `actions` (e.g. the
       Explorer's root log icon) sit at the right edge, after the title. The chevron button is the accessible
       control (testid + aria state); the title button is a redundant click
       target hidden from assistive tech to avoid a duplicate announcement. -->
  <div class="header">
    <button
      type="button"
      class="header-toggle chevron-toggle"
      aria-expanded={expanded}
      aria-label={title}
      data-testid={testid ? `${testid}-header` : undefined}
      onclick={ontoggle}
    >
      <span class="chevron" class:open={expanded} aria-hidden="true">▸</span>
    </button>
    <button
      type="button"
      class="header-toggle title-toggle"
      tabindex="-1"
      aria-hidden="true"
      data-testid={testid ? `${testid}-title` : undefined}
      onclick={ontitleclick ?? ontoggle}
    >
      <span class="title">{title}</span>
    </button>
    {#if actions}
      <div class="header-actions">{@render actions()}</div>
    {/if}
  </div>
  {#if regionParams}
    <!-- Region body: ALWAYS mounted (even collapsed) so the focus backbone can
         target + transiently reveal this Section; only the CONTENT is gated, so
         a shut Section still unmounts its panel. The active-Region background
         paints here, behind the whole body. -->
    <div
      class="body"
      class:region-active={focus.focusedRegion === regionParams.id}
      data-region={regionParams.id}
      data-testid={testid ? `${testid}-body` : undefined}
      use:region={regionParams}
    >
      {#if expanded}
        {@render children()}
      {/if}
    </div>
  {:else if expanded}
    <div class="body" data-testid={testid ? `${testid}-body` : undefined}>
      {@render children()}
    </div>
  {/if}
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    flex: 0 1 auto;
    min-height: 0;
    border-bottom: 1px solid var(--border);
  }

  .header {
    display: flex;
    align-items: center;
    flex: none;
    box-sizing: border-box;
    width: 100%;
    height: 2rem;
    transition: background 0.12s ease;
  }

  .header:hover {
    background: var(--hover);
  }

  .header-toggle {
    display: flex;
    align-items: center;
    box-sizing: border-box;
    height: 100%;
    border: none;
    background: none;
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    text-align: left;
    cursor: pointer;
  }

  .chevron-toggle {
    flex: none;
    padding: 0 0.2rem 0 0.6rem;
  }

  .title-toggle {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0 0.6rem 0 0.15rem;
  }

  .chevron-toggle:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -2px;
    border-radius: var(--radius-sm);
  }

  .header-actions {
    display: flex;
    align-items: center;
    flex: none;
    gap: 0.15rem;
    padding-right: 0.4rem;
  }

  .chevron {
    display: inline-block;
    font-size: 0.7rem;
    transition: transform 0.12s ease;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .body {
    flex: 0 1 auto;
    min-height: 0;
    overflow: auto;
    /* Cap each expanded body to its share of the viewport (minus the three
       2rem headers). `--expanded-count` is set by the sidebar container. */
    max-height: calc((100vh - 6rem) / var(--expanded-count, 3));
  }

  /* When the body hosts a Region (always mounted, content gated by `expanded`)
     a collapsed Section leaves an EMPTY body — clamp it to nothing so it adds
     no height and no scroll affordance. */
  .body:empty {
    max-height: 0;
  }

  /* Active-Region affordance: a faint background lift behind the whole body
     while keyboard focus is in this Region (mirrors the other Regions). The
     body carries tabindex=-1 only as a last-resort entry point, so suppress its
     focus outline — the Focused item's own ring is the spotlight. */
  .body.region-active {
    background: var(--region-active);
  }

  .body:focus {
    outline: none;
  }
</style>
