<script lang="ts">
  // The reader-facing lifecycle of a Concept (OKF v0.2 §5.4 `status`, §5.5
  // `stale_after`): a status chip and/or a `stale` chip. Advisory only — it
  // never gates reading or editing. Renders nothing for a Concept with neither
  // key. All the rules are in `$lib/lifecycle`; staleness is derived here, at
  // display time, against a minute-ticking clock — never stored.
  import { lifecycleView, type Lifecycle } from '$lib/lifecycle';
  import { clock } from '$lib/state/clock.svelte';

  interface Props {
    lifecycle: Lifecycle | null;
    /** Dense lists (the Explorer): leave out the default `stable`. */
    compact?: boolean;
  }

  let { lifecycle, compact = false }: Props = $props();

  const view = $derived(lifecycleView(lifecycle, clock.now, { compact }));
</script>

{#if view}
  <span class="lifecycle" class:compact data-testid="lifecycle" title={view.title}
    >{#if view.status}<span class="chip status-{view.status}" data-testid="lifecycle-status">{view.status}</span
      >{/if}{#if view.stale}<span class="chip stale" data-testid="lifecycle-stale">stale</span>{/if}</span
  >
{/if}

<style>
  .lifecycle {
    display: inline-flex;
    gap: 4px;
    margin-left: 6px;
    vertical-align: middle;
    flex-shrink: 0;
  }

  .chip {
    font-size: 0.72em;
    line-height: 1.5;
    padding: 0 6px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    white-space: nowrap;
    font-weight: 500;
  }

  .compact .chip {
    font-size: 0.68em;
    padding: 0 5px;
  }

  .status-draft {
    border-style: dashed;
  }

  .status-deprecated {
    text-decoration: line-through;
  }

  .stale {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
    background: color-mix(in srgb, var(--danger) 8%, transparent);
  }
</style>
